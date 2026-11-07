"use strict";

const DATA_PATHS = {
  races: "./extracted_data/races.json",
  skills: "./extracted_data/skills.json",
};

const state = {
  races: [],
  skills: [],
  selectedRaceId: "humans",
  humanMode: "homeland-and-profession",
  optionSelections: new Map(),
  packageSelections: new Map(),
  specializationDrafts: new Map(),
  spellLevelDrafts: new Map(),
  teacherConfirmations: new Set(),
  purchases: [],
  search: "",
  statusFilter: "all",
  qualifyingSkillsOnly: false,
};

const elements = {
  raceSelect: document.querySelector("#race-select"),
  raceBadge: document.querySelector("#race-badge"),
  raceDescription: document.querySelector("#race-description"),
  raceOptions: document.querySelector("#race-options"),
  racialChoices: document.querySelector("#racial-choices"),
  racialPurchases: document.querySelector("#racial-purchases"),
  racialGrants: document.querySelector("#racial-grants"),
  skillSearch: document.querySelector("#skill-search"),
  statusFilter: document.querySelector("#status-filter"),
  qualifyingSkillsOnly: document.querySelector("#qualifying-skills-only"),
  skillCount: document.querySelector("#skill-count"),
  skillList: document.querySelector("#skill-list"),
  skillLedger: document.querySelector("#skill-ledger"),
  undoPurchase: document.querySelector("#undo-purchase"),
  raceTab: document.querySelector("#race-tab"),
  skillsTab: document.querySelector("#skills-tab"),
  racePanel: document.querySelector("#race-panel"),
  skillsPanel: document.querySelector("#skills-panel"),
  totalCp: document.querySelector("#total-cp"),
  redCp: document.querySelector("#red-cp"),
  blueCp: document.querySelector("#blue-cp"),
  loadError: document.querySelector("#load-error"),
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function selectedRace() {
  return state.races.find((race) => race.id === state.selectedRaceId) ?? null;
}

function normalize(value) {
  return String(value ?? "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function grantKey(grant) {
  if (grant.spell_level) return `${grant.skill_id}::spell-${grant.spell_level}`;
  return `${grant.skill_id}::${normalize(grant.specialization)}`;
}

function purchaseKey(skillId, specialization = "", spellLevel = null) {
  if (spellLevel !== null) return `${skillId}::spell-${spellLevel}`;
  return `${skillId}::${normalize(specialization)}`;
}

function listOptionGroups(race) {
  if (!race) return [];
  return race.options.filter((group) => {
    if (race.id !== "humans") return true;
    if (state.humanMode === "alternate-path") return group.id === "alternate-paths";
    return group.id === "homelands" || group.id === "professions";
  });
}

function selectedOptionPackages(race) {
  const packages = [];
  for (const group of listOptionGroups(race)) {
    const option = group.choices.find((choice) => choice.id === state.optionSelections.get(group.id))
      ?? group.choices[0];
    if (option) {
      state.optionSelections.set(group.id, option.id);
      if (option.starting_skills) {
        packages.push({
          path: `option:${group.id}:${option.id}`,
          label: option.name,
          package: option.starting_skills,
        });
      }
    }
  }
  return packages;
}

function activePackages(race) {
  if (!race) return [];
  return [
    { path: "race", label: race.name, package: race.starting_skills ?? {} },
    ...selectedOptionPackages(race),
  ];
}

function directGrantEntries(packages) {
  return packages.flatMap(({ path, label, package: skillPackage }) =>
    (skillPackage.grants ?? []).map((grant) => ({ ...grant, source: label, path })),
  );
}

function currentFreeLevel(skillId, specialization = "", spellLevel = null, grants = null) {
  const entries = grants ?? resolveRacialState().grants;
  const requested = purchaseKey(skillId, specialization, spellLevel);
  return entries
    .filter((entry) => grantKey(entry) === requested)
    .reduce((sum, entry) => sum + (entry.quantity ?? entry.level ?? 1), 0);
}

function effectiveLevel(skillId, specialization = null) {
  const grants = resolveRacialState().grants;
  let free = 0;
  for (const entry of grants) {
    if (entry.skill_id !== skillId) continue;
    if (specialization && normalize(entry.specialization) !== normalize(specialization)) continue;
    free += entry.quantity ?? entry.level ?? 1;
  }
  const paid = state.purchases
    .filter((purchase) => {
      if (purchase.skillId !== skillId) return false;
      return !specialization || normalize(purchase.specialization) === normalize(specialization);
    })
    .reduce((sum, purchase) => sum + 1, 0);
  return free + paid;
}

function conditionMatches(choice, context) {
  const condition = choice.condition;
  if (!condition) return true;
  if (condition.homeland_grants_skill) {
    const hasSkill = context.homelandGrants.some((grant) => grant.skill_id === condition.homeland_grants_skill);
    return hasSkill === condition.equals;
  }
  if (condition.has_skill) {
    const hasSkill = context.grants.some((grant) => grant.skill_id === condition.has_skill)
      || state.purchases.some((purchase) => purchase.skillId === condition.has_skill);
    return hasSkill === condition.equals;
  }
  return true;
}

function resolveRacialState() {
  const race = selectedRace();
  if (!race) return { grants: [], groups: [], requiredPurchases: [] };
  const packages = activePackages(race);
  const grants = directGrantEntries(packages);
  for (const purchase of state.purchases) {
    if (purchase.level !== 1) continue;
    const purchasedSkill = state.skills.find((skill) => skill.id === purchase.skillId);
    for (const grant of purchasedSkill?.grants_on_purchase ?? []) {
      grants.push({
        ...grant,
        source: purchasedSkill.name,
        path: `purchase:${purchase.key}`,
      });
    }
  }
  const homelandPackage = packages.find((entry) => entry.path.startsWith("option:homelands:"));
  const homelandGrants = homelandPackage ? (homelandPackage.package.grants ?? []) : [];
  const groups = [];
  const requiredPurchases = new Set();
  const context = { grants, homelandGrants };

  for (const entry of packages) {
    for (const requiredPurchase of entry.package.required_purchases ?? []) {
      requiredPurchases.add(requiredPurchase);
    }
    for (const group of entry.package.choices ?? []) {
      const path = `${entry.path}:choice:${group.id}`;
      const available = group.choices.filter((choice) => conditionMatches(choice, context));
      const selectedId = state.packageSelections.get(path);
      const selected = available.find((choice) => choice.id === selectedId) ?? available[0] ?? null;
      if (selected) {
        state.packageSelections.set(path, selected.id);
        for (const grant of selected.grants ?? []) {
          grants.push({ ...grant, source: entry.label, path });
        }
      } else {
        state.packageSelections.delete(path);
      }
      groups.push({ path, label: entry.label, group, available, selected });
    }
  }
  return { grants, groups, requiredPurchases: [...requiredPurchases] };
}

function createSelect(label, choices, selectedId, onChange, className = "control") {
  const wrapper = node("div", "choice-block");
  const title = node("label", "choice-title", label);
  const select = node("select", className);
  for (const choice of choices) {
    const option = node("option", "", choice.name);
    option.value = choice.id;
    select.append(option);
  }
  select.value = selectedId ?? choices[0]?.id ?? "";
  select.addEventListener("change", () => onChange(select.value));
  title.append(select);
  wrapper.append(title);
  return wrapper;
}

function renderRaceOptions(race) {
  elements.raceOptions.replaceChildren();
  elements.racialChoices.replaceChildren();
  renderRacialPurchases(race);
  if (!race) return;

  if (race.id === "humans") {
    const modeGroup = node("fieldset", "mode-choices");
    const legend = node("legend", "field-label", "Choose one starting path");
    modeGroup.append(legend);
    const modes = [
      ["homeland-and-profession", "One homeland + one profession"],
      ["alternate-path", "One alternate path instead"],
    ];
    for (const [mode, label] of modes) {
      const labelNode = node("label", "radio-card");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "human-mode";
      radio.value = mode;
      radio.checked = state.humanMode === mode;
      radio.addEventListener("change", () => {
        state.humanMode = mode;
        renderAll();
      });
      labelNode.append(radio, node("span", "", label));
      modeGroup.append(labelNode);
    }
    elements.raceOptions.append(modeGroup);
  }

  const groups = listOptionGroups(race);
  for (const group of groups) {
    const option = group.choices.find((choice) => choice.id === state.optionSelections.get(group.id))
      ?? group.choices[0];
    if (!option) continue;
    state.optionSelections.set(group.id, option.id);
    const title = race.id === "humans" && group.id === "alternate-paths"
      ? "Alternate path"
      : group.id.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    const block = createSelect(title, group.choices, option.id, (value) => {
      state.optionSelections.set(group.id, value);
      renderAll();
    });
    elements.raceOptions.append(block);
  }

  const racialState = resolveRacialState();
  if (racialState.groups.length) {
    const heading = node("h3", "eyebrow", "Racial bonus choices");
    elements.racialChoices.append(heading);
    for (const resolved of racialState.groups) {
      const choices = resolved.available.map((choice) => ({
        id: choice.id,
        name: choice.label ?? choice.id.replaceAll("-", " "),
      }));
      if (!choices.length) continue;
      const groupLabel = resolved.group.label
        ?? resolved.group.id.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
      const block = createSelect(groupLabel, choices, resolved.selected?.id, (value) => {
        state.packageSelections.set(resolved.path, value);
        renderAll();
      });
      elements.racialChoices.append(block);
    }
    elements.racialChoices.append(node("p", "choice-help", "Choose one option in each listed group."))
  }
}

function renderRacialPurchases(race) {
  const container = elements.racialPurchases;
  container.replaceChildren();
  const purchases = race?.racial_purchases ?? [];
  if (!purchases.length) return;

  container.append(node("h3", "eyebrow", "Racial abilities"));
  for (const racialPurchase of purchases) {
    const purchasedCount = state.purchases.filter(
      (purchase) => purchase.racialPurchaseId === racialPurchase.id,
    ).length;
    const item = node("div", "racial-purchase");
    const details = node("div", "racial-purchase-details");
    details.append(
      node("strong", "", racialPurchase.name),
      node("p", "muted-copy", racialPurchase.description),
      node("p", "racial-purchase-count", `${purchasedCount} of ${racialPurchase.max_purchases} purchased`),
    );
    const button = node("button", "button", `Purchase · ${racialPurchase.cost_per_purchase} CP`);
    button.type = "button";
    button.disabled = purchasedCount >= racialPurchase.max_purchases;
    button.title = button.disabled
      ? `Maximum of ${racialPurchase.max_purchases} racial resists purchased.`
      : `Purchase racial resist ${purchasedCount + 1} of ${racialPurchase.max_purchases}.`;
    button.addEventListener("click", () => {
      if (purchasedCount >= racialPurchase.max_purchases) return;
      state.purchases.push({
        key: `racial:${racialPurchase.id}`,
        racialPurchaseId: racialPurchase.id,
        name: racialPurchase.name,
        level: purchasedCount + 1,
        maxLevel: racialPurchase.max_purchases,
        status: "racial",
        cost: racialPurchase.cost_per_purchase,
      });
      renderAll();
    });
    item.append(details, button);
    container.append(item);
  }
}

function renderRacialGrants(racialState) {
  elements.racialGrants.replaceChildren();
  const heading = node("h3", "", "Free racial starting skills");
  elements.racialGrants.append(heading);
  const grouped = new Map();
  for (const grant of racialState.grants) {
    const key = `${grantKey(grant)}::${grant.spell_level ?? ""}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.level += grant.quantity ?? grant.level ?? 1;
      existing.sources.add(grant.source);
    } else {
      grouped.set(key, {
        grant,
        level: grant.quantity ?? grant.level ?? 1,
        sources: new Set([grant.source]),
      });
    }
  }
  if (!grouped.size) {
    elements.racialGrants.append(node("p", "empty-note", "No free skill grants listed."));
    return;
  }
  const list = node("div", "grant-list");
  for (const { grant, level, sources } of [...grouped.values()].sort((a, b) => a.grant.name.localeCompare(b.grant.name))) {
    const item = node("div", "grant-item");
    let displayName = grant.name;
    if (grant.specialization) displayName += `: ${grant.specialization}`;
    if (grant.spell_level) displayName += ` · spell level ${grant.spell_level}`;
    item.append(node("span", "", `${displayName} ${grant.spell_level ? `×${level}` : `level ${level}`}`));
    item.append(node("small", "", `FREE · ${[...sources].join(", ")}`));
    list.append(item);
  }
  elements.racialGrants.append(list);
  if (racialState.requiredPurchases.length) {
    const missing = racialState.requiredPurchases.filter((name) =>
      state.purchases.some((purchase) => purchase.name.toLocaleLowerCase() === name.toLocaleLowerCase()),
    );
    if (missing.length) {
      elements.racialGrants.append(node("p", "required-note", `Starting-path requirement: purchase ${missing.join(", ")}.`));
    } else {
      elements.racialGrants.append(node("p", "required-note", `Starting-path requirement met: ${racialState.requiredPurchases.join(", ")}.`));
    }
  }
}

function collectFreeSkillLevel(skillId, specialization = "", spellLevel = null) {
  return currentFreeLevel(skillId, specialization, spellLevel);
}

function specializationRequired(skill) {
  return /\(\s*\)|\[\s*\]/.test(skill.name);
}

function specializationLabel(skill) {
  return skill.name.replace(/\s*[\[(]\s*[\])]\s*/g, "").trim();
}

function nextLevelCost(skill, level, spellLevel) {
  const costs = skill.costs;
  if (costs.formula === "Spell Level + 1") return spellLevel + 1;
  const index = level - 1;
  let amount = costs.by_level[index];
  if (amount === undefined && costs.unlimited) amount = costs.repeat_cost;
  if (amount === undefined) return null;
  if (costs.annotations_by_level?.[index] === "*") return 0;
  return amount;
}

function selectedSkillSpecialization(skill) {
  const draft = state.specializationDrafts.get(skill.id) ?? "";
  return draft.trim();
}

function spellLevelForSkill(skill) {
  if (skill.costs.formula !== "Spell Level + 1") return null;
  return Number(state.spellLevelDrafts.get(skill.id) ?? "1");
}

function paidCount(skillId, specialization = "", spellLevel = null) {
  const key = purchaseKey(skillId, specialization, spellLevel);
  return state.purchases.filter((purchase) => purchase.key === key).length;
}

function dependencyTermMet(rawTerm, purchaseSpecialization = "") {
  let term = rawTerm.trim();
  while (term.startsWith("(") && term.endsWith(")")) term = term.slice(1, -1).trim();
  const orParts = term.split(/\s+OR\s+/i);
  if (orParts.length > 1) return orParts.some((part) => dependencyTermMet(part, purchaseSpecialization));

  const matchingSpecialization = /^matching\s+/i.test(term);
  term = term.replace(/^matching\s+/i, "").trim();
  let minimum = 1;
  let match = term.match(/^(\d+)\+?\s+levels?\s+of\s+(.+)$/i);
  if (match) {
    minimum = Number(match[1]);
    term = match[2].trim();
  } else {
    match = term.match(/^(\d+)\+?\s+(.+)$/);
    if (match) {
      minimum = Number(match[1]);
      term = match[2].trim();
    } else {
      match = term.match(/^(.+?)\s+(\d+)\+$/);
      if (match) {
        term = match[1].trim();
        minimum = Number(match[2]);
      }
    }
  }

  const normalizedTerm = normalize(term);
  if (normalizedTerm === "natural wings") return selectedRace()?.id === "zephilium";
  if (normalizedTerm.startsWith("any opening weapon group")) {
    return state.skills.some((skill) =>
      skill.opening_skill && effectiveLevel(skill.id) > 0,
    );
  }
  const candidates = [...state.skills]
    .map((skill) => ({
      skill,
      baseName: skill.name.replace(/\s*\(\s*\)\s*$/, "").trim(),
    }))
    .sort((a, b) => b.baseName.length - a.baseName.length);
  const candidate = candidates.find(({ baseName }) => {
    const normalizedName = normalize(baseName);
    return normalizedTerm === normalizedName
      || normalizedTerm === `${normalizedName}s`
      || normalizedTerm.startsWith(`${normalizedName} `);
  });
  if (!candidate) return true;

  const suffix = normalizedTerm.slice(normalize(candidate.baseName).length).trim();
  const specialization = suffix && !/^(?:from any|of|matching)$/.test(suffix) ? suffix : null;
  return effectiveLevel(candidate.skill.id, matchingSpecialization ? purchaseSpecialization : specialization) >= minimum;
}

function skillPrerequisites(skill, specialization = "") {
  const unmet = [];
  for (const dependency of skill.dependencies?.skills ?? []) {
    const alternatives = dependency.alternatives?.length
      ? dependency.alternatives
      : [[dependency.expression]];
    const met = alternatives.some((alternative) =>
      alternative.every((term) => dependencyTermMet(term, specialization)),
    );
    if (!met) unmet.push(dependency.expression);
  }
  return unmet;
}

function teacherNeeded(skill, nextLevel) {
  const requirements = skill.dependencies?.teacher ?? [];
  return requirements.some((requirement) => {
    const beyond = requirement.match(/beyond\s+(\d+)/i);
    return !beyond || nextLevel > Number(beyond[1]);
  });
}

function skillDetailText(skill) {
  const requirements = (skill.dependencies?.skills ?? []).map((dependency) => dependency.expression);
  const teachers = skill.dependencies?.teacher ?? [];
  return [
    requirements.length ? `Requires: ${requirements.join("; ")}` : "",
    teachers.length ? `Teacher: ${teachers.join("; ")}` : "",
    `Rulebook page ${skill.source_page}`,
  ].filter(Boolean).join(" · ");
}

function skillLevelForPurchase(skill, specialization, spellLevel) {
  if (spellLevel !== null) {
    return collectFreeSkillLevel(skill.id, "", spellLevel) + paidCount(skill.id, "", spellLevel) + 1;
  }
  return collectFreeSkillLevel(skill.id, specialization) + paidCount(skill.id, specialization) + 1;
}

function renderSkillList() {
  const query = normalize(state.search);
  const visible = state.skills.filter((skill) => {
    if (state.statusFilter !== "all" && skill.status !== state.statusFilter) return false;
    if (state.qualifyingSkillsOnly
      && skillPrerequisites(skill, selectedSkillSpecialization(skill)).length > 0) return false;
    return !query
      || normalize(`${skill.name} ${skill.dependencies?.skills?.map((item) => item.expression).join(" ") ?? ""}`)
        .includes(query);
  });
  elements.skillCount.textContent = `${visible.length} skill${visible.length === 1 ? "" : "s"} shown`;
  elements.skillList.replaceChildren();

  for (const skill of visible) {
    const specialization = selectedSkillSpecialization(skill);
    const spellLevel = spellLevelForSkill(skill);
    const level = skillLevelForPurchase(skill, specialization, spellLevel);
    const cost = nextLevelCost(skill, level, spellLevel);
    const unmet = skillPrerequisites(skill, specialization);
    const teacherRequired = teacherNeeded(skill, spellLevel ?? level);
    const teacherKey = purchaseKey(skill.id, specialization, spellLevel);
    const teacherConfirmed = state.teacherConfirmations.has(teacherKey);
    const noSpecialization = specializationRequired(skill) && !specialization;
    const maxed = !skill.costs.unlimited && skill.costs.formula !== "Spell Level + 1"
      && skill.costs.by_level.length > 0 && level > skill.costs.by_level.length;
    const formulaInvalid = spellLevel !== null && (!Number.isInteger(spellLevel) || spellLevel < 1 || spellLevel > 9);
    const spellSlotBlocked = spellLevel !== null && spellLevel > 1
      && collectFreeSkillLevel(skill.id, "", spellLevel - 1) + paidCount(skill.id, "", spellLevel - 1)
        <= collectFreeSkillLevel(skill.id, "", spellLevel) + paidCount(skill.id, "", spellLevel);
    const buttonDisabled = !skill.costs.purchasable || cost === null || unmet.length > 0
      || (teacherRequired && !teacherConfirmed) || noSpecialization || maxed || formulaInvalid || spellSlotBlocked;

    const row = node("article", "skill-row");
    const top = node("div", "skill-top");
    const heading = node("h3", "skill-name", skill.name.replace(/\s*\(\s*\)\s*/g, " (choose one)"));
    const status = node("span", `skill-status ${skill.status}`, skill.status);
    heading.append(status);
    top.append(heading);
    row.append(top);

    const levelSummary = `Current level ${Math.max(0, level - 1)}${cost === null || maxed ? " · maximum reached" : ` · next level ${level}`}`;
    const costLabel = !skill.costs.purchasable
      ? `Not purchasable (${skill.costs.source_text})`
      : cost === null
        ? "No further levels listed"
        : `${cost} CP for next level`;
    const meta = node("p", "skill-meta");
    meta.append(node("span", "skill-cost", costLabel), document.createTextNode(` · ${levelSummary}`));
    row.append(meta);
    row.append(node("p", "skill-meta skill-prereq", skillDetailText(skill)));
    if (skill.opening_skill || skill.probationary) {
      const flags = node("div", "skill-flags");
      if (skill.opening_skill) flags.append(node("span", "mini-tag", "Opening skill"));
      if (skill.probationary) flags.append(node("span", "mini-tag probationary", "Probationary"));
      row.append(flags);
    }

    const controls = node("div", "purchase-controls");
    if (specializationRequired(skill)) {
      const field = node("div", "inline-field specialization");
      const label = node("label", "", `${specializationLabel(skill)} specialization`);
      const input = node("input", "control");
      input.type = "text";
      input.placeholder = "Enter focus";
      input.value = specialization;
      input.addEventListener("change", () => {
        state.specializationDrafts.set(skill.id, input.value);
        renderSkillList();
      });
      field.append(label, input);
      controls.append(field);
    }
    if (spellLevel !== null) {
      const field = node("div", "inline-field spell-level");
      const label = node("label", "", "Spell level");
      const select = node("select", "control");
      for (let value = 1; value <= 9; value += 1) {
        const option = node("option", "", `Level ${value}`);
        option.value = String(value);
        select.append(option);
      }
      select.value = String(spellLevel);
      select.addEventListener("change", () => {
        state.spellLevelDrafts.set(skill.id, select.value);
        renderSkillList();
      });
      field.append(label, select);
      controls.append(field);
    }
    const addButton = node("button", "button", cost === null ? "Add level" : `Add · ${cost} CP`);
    addButton.type = "button";
    addButton.disabled = buttonDisabled;
    addButton.title = buttonDisabled ? purchaseBlockedReason({
      skill, cost, unmet, teacherRequired, teacherConfirmed, noSpecialization, maxed, formulaInvalid, spellSlotBlocked,
    }) : `Purchase the next level of ${skill.name}`;
    addButton.addEventListener("click", () => {
      const finalSpecialization = specializationRequired(skill)
        ? row.querySelector(".specialization input")?.value.trim() ?? ""
        : "";
      const finalSpellLevel = spellLevel === null ? null : Number(row.querySelector(".spell-level select").value);
      purchaseSkill(skill, finalSpecialization, finalSpellLevel);
    });
    controls.append(addButton);
    row.append(controls);

    if (teacherRequired) {
      const teacherLabel = node("label", "teacher-check");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = teacherConfirmed;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.teacherConfirmations.add(teacherKey);
        else state.teacherConfirmations.delete(teacherKey);
        renderSkillList();
      });
      teacherLabel.append(checkbox, document.createTextNode("I have met this level's teacher/page requirement"));
      row.append(teacherLabel);
    }
    if (unmet.length) row.append(node("p", "blocked-reason", `Prerequisite not met: ${unmet.join("; ")}`));
    else if (spellSlotBlocked) row.append(node("p", "blocked-reason", `Need another level ${spellLevel - 1} spell slot first.`));
    else if (noSpecialization) row.append(node("p", "blocked-reason", "Enter a specialization to purchase this skill."));
    else if (teacherRequired && !teacherConfirmed) row.append(node("p", "blocked-reason", "Confirm the teacher requirement to enable purchase."));
    elements.skillList.append(row);
  }
}

function purchaseBlockedReason(details) {
  if (!details.skill.costs.purchasable) return "This skill cannot be purchased with CP.";
  if (details.maxed || details.cost === null) return "No additional level is listed.";
  if (details.noSpecialization) return "Enter a specialization first.";
  if (details.unmet.length) return `Prerequisites not met: ${details.unmet.join("; ")}`;
  if (details.spellSlotBlocked) return "Purchase a lower-level spell slot first.";
  if (details.formulaInvalid) return "Choose a spell level from 1 to 9.";
  if (details.teacherRequired && !details.teacherConfirmed) return "Confirm the teacher/page requirement first.";
  return "This skill is not currently available.";
}

function purchaseSkill(skill, specialization = "", spellLevel = null) {
  const level = skillLevelForPurchase(skill, specialization, spellLevel);
  const cost = nextLevelCost(skill, level, spellLevel);
  const unmet = skillPrerequisites(skill, specialization);
  const teacherRequired = teacherNeeded(skill, spellLevel ?? level);
  const teacherKey = purchaseKey(skill.id, specialization, spellLevel);
  if (!skill.costs.purchasable || cost === null || unmet.length || (teacherRequired && !state.teacherConfirmations.has(teacherKey))) {
    return;
  }
  const key = purchaseKey(skill.id, specialization, spellLevel);
  state.purchases.push({
    key,
    skillId: skill.id,
    name: skill.name.replace(/\s*\(\s*\)\s*/g, ""),
    specialization,
    spellLevel,
    level,
    status: skill.status,
    cost,
  });
  state.teacherConfirmations.delete(teacherKey);
  renderAll();
}

function purchaseRemovalBlockers(purchaseIndex) {
  const purchase = state.purchases[purchaseIndex];
  if (!purchase) return [];
  const originalPurchases = state.purchases;
  state.purchases = originalPurchases.filter((_, index) => index !== purchaseIndex);
  try {
    const invalidPurchases = state.purchases.filter((remainingPurchase) => {
      const skill = state.skills.find((entry) => entry.id === remainingPurchase.skillId);
      return skill && skillPrerequisites(skill, remainingPurchase.specialization).length > 0;
    });
    return [...new Set(invalidPurchases.map((entry) => entry.name))];
  } finally {
    state.purchases = originalPurchases;
  }
}

function removePurchaseAt(index) {
  if (index < 0 || index >= state.purchases.length) return;
  if (purchaseRemovalBlockers(index).length) return;
  const [removed] = state.purchases.splice(index, 1);
  state.teacherConfirmations.delete(removed.key);
  renderAll();
}

function renderSkillLedger() {
  elements.skillLedger.replaceChildren();
  const grants = resolveRacialState().grants;
  const grouped = new Map();
  for (const grant of grants) {
    const key = grantKey(grant);
    const row = grouped.get(key) ?? {
      name: grant.name,
      specialization: grant.specialization ?? "",
      spellLevel: grant.spell_level ?? null,
      free: 0,
      paid: 0,
      sources: new Set(),
      purchaseKey: grantKey(grant),
    };
    row.free += grant.quantity ?? grant.level ?? 1;
    row.sources.add(grant.source);
    grouped.set(key, row);
  }
  for (const purchase of state.purchases) {
    const row = grouped.get(purchase.key) ?? {
      name: purchase.name,
      specialization: purchase.specialization,
      spellLevel: purchase.spellLevel,
      free: 0,
      paid: 0,
      sources: new Set(),
      purchaseKey: purchase.key,
      racial: Boolean(purchase.racialPurchaseId),
      maxLevel: purchase.maxLevel ?? null,
    };
    row.paid += 1;
    if (purchase.racialPurchaseId) {
      row.racial = true;
      row.maxLevel = purchase.maxLevel;
    }
    grouped.set(purchase.key, row);
  }
  if (!grouped.size) {
    elements.skillLedger.append(node("p", "empty-note", "Choose a race to see starting skills."));
  } else {
    for (const row of [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name) || a.specialization.localeCompare(b.specialization))) {
      const ledgerRow = node("div", "ledger-row");
      const left = node("div", "");
      let label = row.name;
      if (row.specialization) label += ` · ${row.specialization}`;
      if (row.spellLevel) label += ` · spell level ${row.spellLevel}`;
      left.append(node("div", "ledger-name", label));
      const details = [];
      if (row.free) details.push(`${row.free} free`);
      if (row.paid) details.push(`${row.paid} purchased`);
      if (row.sources.size) details.push([...row.sources].join(", "));
      left.append(node("div", "ledger-detail", details.join(" · ")));
      const total = row.free + row.paid;
      const controls = node("div", "ledger-actions");
      controls.append(node("span", "ledger-level", row.racial ? `${total}/${row.maxLevel}` : `Lv ${total}`));
      let purchaseIndex = -1;
      if (row.paid) {
        for (let index = state.purchases.length - 1; index >= 0; index -= 1) {
          if (state.purchases[index].key === row.purchaseKey) {
            purchaseIndex = index;
            break;
          }
        }
      }
      const blockers = purchaseIndex >= 0 ? purchaseRemovalBlockers(purchaseIndex) : [];
      const removeButton = node("button", "button button-remove", "Remove");
      removeButton.type = "button";
      removeButton.disabled = purchaseIndex < 0 || blockers.length > 0;
      removeButton.title = purchaseIndex < 0
        ? "Free racial grants cannot be removed."
        : blockers.length
          ? `Remove dependent purchases first: ${blockers.join(", ")}.`
          : row.racial
            ? `Remove the most recently purchased racial resist of ${label}.`
            : `Remove the most recently purchased level of ${label}.`;
      removeButton.setAttribute("aria-label", row.racial
        ? `Remove one racial purchase of ${label}`
        : `Remove one purchased level of ${label}`);
      if (purchaseIndex >= 0 && !blockers.length) {
        removeButton.addEventListener("click", () => removePurchaseAt(purchaseIndex));
      }
      controls.append(removeButton);
      ledgerRow.append(left, controls);
      elements.skillLedger.append(ledgerRow);
    }
  }
  elements.undoPurchase.disabled = state.purchases.length === 0;
}

function renderTotals() {
  const totals = { red: 0, blue: 0, grey: 0, racial: 0 };
  for (const purchase of state.purchases) {
    totals[purchase.status] += purchase.cost;
  }
  elements.totalCp.textContent = String(totals.red + totals.blue + totals.grey + totals.racial);
  elements.redCp.textContent = String(totals.red);
  elements.blueCp.textContent = String(totals.blue);
}

function setActiveTab(tab) {
  const showRace = tab === "race";
  elements.raceTab.setAttribute("aria-selected", String(showRace));
  elements.raceTab.tabIndex = showRace ? 0 : -1;
  elements.skillsTab.setAttribute("aria-selected", String(!showRace));
  elements.skillsTab.tabIndex = showRace ? -1 : 0;
  elements.racePanel.hidden = !showRace;
  elements.skillsPanel.hidden = showRace;
}

function renderRacePanel() {
  const race = selectedRace();
  if (!race) return;
  elements.raceBadge.replaceChildren();
  const badge = node("span", `badge${race.restricted ? " restricted" : ""}`, race.restricted ? "Restricted · VP required" : "Standard race");
  elements.raceBadge.append(badge);
  elements.raceDescription.textContent = race.restricted
    ? "This race is marked restricted in the rulebook and requires VP."
    : "Select the race's available origin and package choices.";
  renderRaceOptions(race);
  const racialState = resolveRacialState();
  renderRacialGrants(racialState);
}

function renderAll() {
  renderRacePanel();
  renderSkillList();
  renderSkillLedger();
  renderTotals();
}

function setupRaceSelect() {
  elements.raceSelect.replaceChildren();
  for (const race of state.races) {
    const option = node("option", "", race.name + (race.restricted ? " · Restricted" : ""));
    option.value = race.id;
    elements.raceSelect.append(option);
  }
  elements.raceSelect.value = state.selectedRaceId;
  elements.raceSelect.addEventListener("change", () => {
    state.selectedRaceId = elements.raceSelect.value;
    state.humanMode = "homeland-and-profession";
    state.optionSelections.clear();
    state.packageSelections.clear();
    state.purchases = [];
    state.teacherConfirmations.clear();
    renderAll();
  });
}

function setupControls() {
  const tabs = [elements.raceTab, elements.skillsTab];
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => setActiveTab(index === 0 ? "race" : "skills"));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === "Home" ? 0
        : event.key === "End" ? tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[nextIndex].focus();
      tabs[nextIndex].click();
    });
  }
  elements.skillSearch.addEventListener("input", () => {
    state.search = elements.skillSearch.value;
    renderSkillList();
  });
  elements.statusFilter.addEventListener("change", () => {
    state.statusFilter = elements.statusFilter.value;
    renderSkillList();
  });
  elements.qualifyingSkillsOnly.addEventListener("change", () => {
    state.qualifyingSkillsOnly = elements.qualifyingSkillsOnly.checked;
    renderSkillList();
  });
  elements.undoPurchase.addEventListener("click", () => {
    const purchase = state.purchases.pop();
    if (purchase) state.teacherConfirmations.delete(purchase.key);
    renderAll();
  });
}

async function loadData() {
  const [raceResponse, skillResponse] = await Promise.all([
    fetch(DATA_PATHS.races),
    fetch(DATA_PATHS.skills),
  ]);
  if (!raceResponse.ok || !skillResponse.ok) {
    throw new Error(`Could not load character data (races: ${raceResponse.status}, skills: ${skillResponse.status}).`);
  }
  const [raceData, skillData] = await Promise.all([raceResponse.json(), skillResponse.json()]);
  if (!Array.isArray(raceData.races) || !Array.isArray(skillData.skills)) {
    throw new Error("The race or skill JSON has an unexpected format.");
  }
  state.races = raceData.races;
  state.skills = skillData.skills;
  if (!state.races.some((race) => race.id === state.selectedRaceId)) {
    state.selectedRaceId = state.races[0]?.id ?? "";
  }
  setupRaceSelect();
  setupControls();
  renderAll();
}

loadData().catch((error) => {
  elements.loadError.hidden = false;
  elements.loadError.textContent = `Unable to start the character builder: ${error.message} Start a local web server from the project directory (for example, python3 -m http.server 8000) and open http://localhost:8000/.`;
});
