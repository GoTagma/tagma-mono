const shaPattern = /^[a-f0-9]{64}$/;

// This module only recognizes a narrow clarification class. A trusted caller must
// supply independent user authority and an already verified source identity.
export function createClarificationPolicyResolvers({
  expectedSourceSha,
  requiredNewWorkspaceAuthority,
  requiredGoalAuthority,
} = {}) {
  if (
    !shaPattern.test(expectedSourceSha ?? '') ||
    typeof requiredNewWorkspaceAuthority !== 'string' ||
    !requiredNewWorkspaceAuthority.trim() ||
    typeof requiredGoalAuthority !== 'string' ||
    !requiredGoalAuthority.trim()
  ) {
    throw new TypeError(
      'Clarification policy requires an exact source digest and independent authorities.',
    );
  }
  function resolvedNewWorkspaceClarification(pending, operation, originalPrompt, policy) {
    if (
      policy?.newWorkspaceNamedPipeline !== 'create_new' ||
      policy?.newWorkspaceAuthority !== requiredNewWorkspaceAuthority
    )
      return null;
    if (
      typeof originalPrompt !== 'string' ||
      typeof operation?.operationId !== 'string' ||
      !operation.operationId ||
      !Number.isSafeInteger(operation.generation) ||
      operation.generation < 1 ||
      !Number.isSafeInteger(operation.version) ||
      operation.version < 1
    )
      return null;
    if (
      pending?.kind !== 'clarification' ||
      operation?.executionState !== 'waiting_for_user' ||
      pending.operationId !== operation.operationId ||
      pending.generation !== operation.generation ||
      pending.operationVersion !== operation.version ||
      typeof pending.clarificationId !== 'string' ||
      !pending.clarificationId
    )
      return null;
    if (
      typeof pending.question !== 'string' ||
      !Array.isArray(pending.candidates) ||
      pending.candidates.length !== 0
    )
      return null;
    const parts = pending.question.split('?');
    if (
      parts.length > 2 ||
      [
        ...pending.question.matchAll(
          /\b(?:Do you want|Would you like|Should I|Are you (?:asking|looking) for)\b/gi,
        ),
      ].length > 1
    )
      return null;
    const suffix = (parts[1] ?? '').trim();
    if (
      suffix &&
      !/^(?:The\s+request\s+names\s+a\s+file\s+that\s+(?:doesn't|does\s+not)\s+match\s+the\s+(?:inventoried|existing|current)\s+pipeline|The\s+requested\s+(?:file|filename)\s+(?:doesn't|does\s+not)\s+match\s+the\s+(?:inventoried|existing|current)\s+pipeline)\.?$/i.test(
        suffix,
      )
    )
      return null;
    const question = parts[0];
    const creationPattern =
      /\b(?:create\s+(?:(?:this|it)\s+as\s+)?(?:(?:a|the)\s+)?(?:brand[- ]?)?new\s+pipeline|created\s+as\s+(?:(?:a|the)\s+)?(?:brand[- ]?)?new\s+pipeline)\s+(?:(?:at|named|called)\s+([`"']?)([A-Za-z0-9_-]+\.ya?ml)\1|\(\s*([`"']?)([A-Za-z0-9_-]+\.ya?ml)\3\s*\))(?=$|[\s,.;:])/gi;
    const creations = [...question.matchAll(creationPattern)].map((match) => ({
      match,
      filename: match[2] ?? match[4],
    }));
    if (new Set(creations.map(({ filename }) => filename)).size !== 1) return null;
    const comparisons = creations.filter(({ match }) => {
      const remaining = question.slice(match.index + match[0].length);
      const existing =
        /^[\s,;]*(?:instead[\s,;]+)?(?:or|versus|vs\.?)\s+(?:edit|modify|update)\s+(?:the\s+)?existing\s+([\s\S]+)$/i.exec(
          remaining,
        );
      if (existing) {
        const target = existing[1]
          .trim()
          .replace(/\s+instead\s*$/i, '')
          .trim();
        if (/\b(?:and|or|then|also)\b/i.test(target)) return false;
        return /^(?:pipeline|(?:[A-Za-z0-9_-]+\s+){1,6}pipeline|current[- ]canvas\s+draft|(?:default|blank)\s+draft)(?:\s+(?:"[^"\r\n?]+"|'[^'\r\n?]+'|`[^`\r\n?]+`))?$/i.test(
          target,
        );
      }
      if (
        /^[\s,;]*(?:or|versus|vs\.?)\s+(?:build|put|integrate)\s+(?:it|this)\s+(?:into|in)\s+(?:the\s+)?current\s+(?:(?:untitled|blank|default)\s+)?canvas\s+draft(?:\s+instead)?\s*$/i.test(
          remaining,
        )
      )
        return true;
      const describedBuild =
        /^[\s,;]*(?:or|versus|vs\.?)\s+(?:build|put|integrate)\s+(?:this|the\s+requested)\s+((?:[A-Za-z][A-Za-z0-9_-]*\s+){0,3}(?:workflow|pipeline|task))\s+(?:into|in)\s+(?:the\s+)?existing\s+current[- ]canvas\s+(?:pipeline|draft)(?:\s+instead)?\s*$/i.exec(
          remaining,
        );
      if (describedBuild) {
        const phrase = describedBuild[1].trim();
        if (phrase.split(/\s+/).some((word) => /^(?:and|or|then|also)$/i.test(word))) return false;
        const sourcePhrase = phrase
          .split(/\s+/)
          .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('\\s+');
        return new RegExp(`(?:^|[^A-Za-z0-9_-])${sourcePhrase}(?=$|[^A-Za-z0-9_-])`, 'i').test(
          originalPrompt,
        );
      }
      const replace =
        /^[\s,;]*(?:or|versus|vs\.?)\s+(?:should\s+(?:it|this)\s+)?(?:replace(?:\s*\/\s*update)?|update)\s+(?:the\s+)?(current[- ]canvas\s+[\s\S]+)$/i.exec(
          remaining,
        );
      if (!replace || /\b(?:and|or|then|also)\b/i.test(replace[1])) return false;
      return /^current[- ]canvas\s+(?:(?:[A-Za-z0-9_-]+\s+){0,6}pipeline\s+)?draft(?:\s+instead)?\s*$/i.test(
        replace[1],
      );
    });
    if (comparisons.length !== 1) return null;
    const filename = comparisons[0].filename;
    if (
      !new RegExp(
        String.raw`(?:^|[^A-Za-z0-9_.\\/-])${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^A-Za-z0-9_.\\/-]|\.(?=$|[^A-Za-z0-9_.\\/-]))`,
      ).test(originalPrompt)
    )
      return null;
    return {
      text: 'Create the new pipeline at the requested filename; do not modify the default blank draft.',
      requestedFilename: filename,
      authority: policy.newWorkspaceAuthority,
    };
  }
  function resolvedOriginalTestGoalClarification(
    pending,
    operation,
    policy,
    caseId,
    originalPrompt,
  ) {
    if (policy?.pipelineGoalAuthority !== requiredGoalAuthority) return null;
    const goal = policy?.originalTestPipelineGoals?.find(
      (item) =>
        item.caseId === caseId &&
        item.goal === 'pipeline_generation' &&
        item.sourceSha256 === expectedSourceSha &&
        shaPattern.test(item.criterionSha256 ?? '') &&
        typeof item.criterion === 'string' &&
        /\bpipeline\b/i.test(item.criterion),
    );
    if (
      !goal ||
      pending?.kind !== 'clarification' ||
      typeof operation?.operationId !== 'string' ||
      !operation.operationId ||
      !Number.isSafeInteger(operation.generation) ||
      operation.generation < 1 ||
      !Number.isSafeInteger(operation.version) ||
      operation.version < 1 ||
      operation.executionState !== 'waiting_for_user' ||
      pending.operationId !== operation.operationId ||
      pending.generation !== operation.generation ||
      pending.operationVersion !== operation.version ||
      typeof pending.clarificationId !== 'string' ||
      !pending.clarificationId ||
      !Array.isArray(pending.candidates) ||
      pending.candidates.length !== 0
    )
      return null;
    const question = pending.question;
    if (typeof question !== 'string' || /\?[^?]*\S/.test(question)) return null;
    const intentStems = [
      ...question.matchAll(
        /\b(?:Do you want|Would you like|Should I|Are you (?:asking|looking) for)\b/gi,
      ),
    ];
    if (intentStems.length < 1 || intentStems.length > 2) return null;
    const prefix =
      /^\s*(?:Do you want|Would you like|Are you (?:asking|looking) for|Should I)\s+/i.exec(
        question,
      );
    if (!prefix) return null;
    const choices = question
      .slice(prefix[0].length)
      .trim()
      .replace(/[?.]\s*$/, '');
    const alternatives = [];
    let begin = 0,
      depth = 0,
      quote = null;
    for (let index = 0; index < choices.length; index++) {
      const char = choices[index];
      if (quote) {
        if (char === '\\') index++;
        else if (char === quote) quote = null;
        continue;
      }
      if (
        char === '"' ||
        char === '`' ||
        (char === "'" && (index === 0 || /[\s,(]/.test(choices[index - 1])))
      ) {
        quote = char;
        continue;
      }
      if (char === '(') {
        if (++depth > 4) return null;
        continue;
      }
      if (char === ')') {
        if (--depth < 0) return null;
        continue;
      }
      if (depth !== 0) continue;
      const or =
        choices.slice(index, index + 2).toLowerCase() === 'or' &&
        (index === 0 || /\s/.test(choices[index - 1])) &&
        /\s/.test(choices[index + 2] ?? '');
      if (
        or &&
        /\bnew\s*$/i.test(choices.slice(begin, index)) &&
        /^or\s+edited\s+pipeline\b/i.test(choices.slice(index))
      )
        continue;
      if (char !== ',' && char !== ';' && !or) continue;
      const part = choices.slice(begin, index).trim();
      if (part) alternatives.push(part);
      if (or) index++;
      begin = index + 1;
    }
    if (depth !== 0 || quote !== null) return null;
    const final = choices.slice(begin).trim();
    if (final) alternatives.push(final);
    if (alternatives.length < 2 || alternatives.length > 3) return null;
    if (intentStems.length === 2) {
      const stem = prefix[0].trim();
      const normalized = (text) => text.toLowerCase().replace(/\s+/g, ' ');
      const repeated = new RegExp(
        `^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\s+`,
        'i',
      );
      if (
        alternatives.length !== 2 ||
        !/\bor\s+$/i.test(question.slice(0, intentStems[1].index)) ||
        normalized(intentStems[1][0]) !== normalized(stem) ||
        !repeated.test(alternatives[1])
      )
        return null;
      alternatives[1] = alternatives[1].replace(repeated, '');
    }
    const sourceBoundOneOff = new Set(
      alternatives.filter((alternative) => {
        const match =
          /^(?:this|that|the\s+requested)\s+((?:[A-Za-z][A-Za-z0-9_-]*\s+){0,3}[A-Za-z][A-Za-z0-9_-]*)\s+([A-Za-z][A-Za-z0-9_-]*(?:ed|d))\s+as\s+a\s+one[- ]off\s+action\s+using\s+([A-Za-z][A-Za-z0-9_]*)$/i.exec(
            alternative,
          );
        if (!match || typeof originalPrompt !== 'string') return false;
        const subjectWords = match[1].split(/\s+/);
        if (subjectWords.some((word) => /^(?:and|or|then|also)$/i.test(word))) return false;
        const word = (token) => new RegExp(`(?:^|[^A-Za-z0-9_-])${token}(?=$|[^A-Za-z0-9_-])`, 'i');
        const passive = match[2];
        const verbs = [
          /ed$/i.test(passive) ? passive.slice(0, -2) : null,
          /d$/i.test(passive) ? passive.slice(0, -1) : null,
        ].filter(Boolean);
        const subject = new RegExp(
          `(?:^|[^A-Za-z0-9_-])${subjectWords.join('\\s+')}(?=$|[^A-Za-z0-9_-])`,
          'i',
        );
        const method = new RegExp(
          `(?:^|[^A-Za-z0-9_-])using\\s+${match[3]}(?=$|[^A-Za-z0-9_-])`,
          'i',
        );
        return (
          verbs.some((verb) => word(verb).test(originalPrompt)) &&
          subject.test(originalPrompt) &&
          method.test(originalPrompt)
        );
      }),
    );
    if (sourceBoundOneOff.size > 0 && alternatives.length !== 2) return null;
    if (intentStems.length === 2 && sourceBoundOneOff.size !== 1) return null;
    const roles = [];
    for (const alternative of alternatives) {
      if (sourceBoundOneOff.has(alternative)) {
        roles.push('one-off');
        continue;
      }
      if (
        /^(?:(?:an?|the)\s+)?(?:explanation|overview)\b|^(?:me\s+to\s+)?(?:explain|provide\s+(?:an?\s+)?explanation)\b/i.test(
          alternative,
        )
      ) {
        roles.push('explanation');
        continue;
      }
      if (
        /^(?:(?:an?|the)\s+)?one[- ]off\b|^(?:run|perform|do)\s+(?:an?\s+)?one[- ]off\b/i.test(
          alternative,
        )
      ) {
        roles.push('one-off');
        continue;
      }
      const pipeline =
        /^(?:(?:a|the)\s+)?(?:to\s+)?(?:pipeline\s+(?:change|update)|(?:change|update)\s+(?:to|in)\s+(?:(?:a|the)\s+)?(?:current\s+)?pipeline|(?:create|build|generate|set\s+up|edit|modify|update)\s+(?:(?:a|the)\s+)?(?:(?:new|current|existing)\s+)?pipeline|new(?:\s+or\s+edited)?\s+pipeline|reusable\s+pipeline)\b/i.exec(
          alternative,
        );
      if (!pipeline) return null;
      let remaining = alternative.slice(pipeline[0].length).trim();
      if (remaining.startsWith('(')) {
        const parenthetical = /^\(\s*new\s+or\s+edited\s+pipeline\s*\)/i.exec(remaining);
        if (!parenthetical) return null;
        remaining = remaining.slice(parenthetical[0].length).trim();
      }
      const simpleReference =
        /^(?:instead|to\s+(?:set\s+(?:this|that|it)\s+up|set\s+up\s+(?:this|that|it|the\s+requested\s+task)|(?:perform|implement|execute)\s+(?:this|that|it|(?:the\s+requested|the|this|that)\s+task))|(?:that|so\s+it)\s+(?:performs|does|executes)\s+(?:this|that|it|(?:the\s+requested|the|this|that)\s+task)|for\s+(?:this|that|the\s+requested)\s+(?:task|request))?$/i.test(
          remaining,
        );
      const qualifiedReference =
        /^(?:that|so\s+it)\s+(?:performs|does|executes)\s+(?:this|that|the\s+requested)\s+([A-Za-z][A-Za-z0-9_]*)-based\s+([A-Za-z][A-Za-z0-9_]*)$/i.exec(
          remaining,
        );
      const criterionBound =
        qualifiedReference &&
        new RegExp(`(?:^|[^A-Za-z0-9_])${qualifiedReference[1]}(?=$|[^A-Za-z0-9_])`, 'i').test(
          goal.criterion,
        );
      const taskToken =
        qualifiedReference &&
        new RegExp(`(?:^|[^A-Za-z0-9_])${qualifiedReference[2]}(?=$|[^A-Za-z0-9_])`, 'i');
      const taskBound =
        taskToken &&
        typeof originalPrompt === 'string' &&
        taskToken.test(originalPrompt) &&
        alternatives.some((other) => other !== alternative && taskToken.test(other));
      const sourceActionReference =
        /^that\s+([A-Za-z][A-Za-z0-9_-]*)\s+(?:a|an|the)\s+((?:[A-Za-z][A-Za-z0-9_-]*\s+){0,3}[A-Za-z][A-Za-z0-9_-]*)\s+using\s+([A-Za-z][A-Za-z0-9_]*)$/i.exec(
          remaining,
        );
      let sourceActionBound = false;
      if (sourceActionReference && typeof originalPrompt === 'string') {
        const word = (token) => new RegExp(`(?:^|[^A-Za-z0-9_-])${token}(?=$|[^A-Za-z0-9_-])`, 'i');
        const verb = sourceActionReference[1];
        const verbs = [verb, /s$/i.test(verb) ? verb.slice(0, -1) : null].filter(Boolean);
        const subjectWords = sourceActionReference[2].split(/\s+/);
        const subject = new RegExp(
          `(?:^|[^A-Za-z0-9_-])${subjectWords.join('\\s+')}(?=$|[^A-Za-z0-9_-])`,
          'i',
        );
        const method = word(sourceActionReference[3]);
        const originalMethod = new RegExp(
          `(?:^|[^A-Za-z0-9_-])using\\s+${sourceActionReference[3]}(?=$|[^A-Za-z0-9_-])`,
          'i',
        );
        sourceActionBound =
          verbs.some((token) => word(token).test(originalPrompt)) &&
          subject.test(originalPrompt) &&
          originalMethod.test(originalPrompt) &&
          method.test(goal.criterion) &&
          alternatives.some(
            (other) =>
              other !== alternative &&
              word(subjectWords[0]).test(other) &&
              verbs.some((token) => word(token).test(other)),
          );
      }
      const sourceBoundPassiveReference =
        sourceBoundOneOff.size === 1 &&
        /^(?:built|created|generated|set\s+up)\s+to\s+do\s+(?:it|this|that)$/i.test(remaining);
      const taskReference =
        /^(?:that|so\s+it)\s+(?:performs|does|executes)\s+(?:this|that|the\s+requested)\s+([A-Za-z][A-Za-z0-9_-]*)$/i.exec(
          remaining,
        );
      let explicitSourceTaskBound = false;
      if (taskReference && alternatives.length === 3 && typeof originalPrompt === 'string') {
        const term = taskReference[1];
        const originalTask = new RegExp(
          `^\\s*(?:Please\\s+|I\\s+want\\s+to\\s+)?${term}(?=$|[^A-Za-z0-9_-])`,
          'i',
        );
        const oneOffTask = new RegExp(
          `^(?:(?:a|an|the)\\s+)?one[- ]off\\s+${term}(?:\\s+(?:action|result|task))?(?:\\s+performed)?(?:\\s+for\\s+(?:you|me))?(?:\\s+(?:now|right\\s+now))?$`,
          'i',
        );
        const explanation = new RegExp(
          `^(?:(?:a|an|the)\\s+)?(?:explanation|overview)\\s+of\\s+(?:how\\s+to\\s+${term}|${term}ing)((?:\\s+[A-Za-z][A-Za-z0-9_-]*){0,12})$`,
          'i',
        );
        const explanationBound =
          alternatives.filter((other) => {
            const match = explanation.exec(other);
            if (!match) return false;
            const words = match[1].trim().split(/\s+/).filter(Boolean);
            return words.every(
              (word) =>
                !/^(?:and|or|then|also|but)$/i.test(word) &&
                (/^(?:a|an|the|this|that|your|my|our)$/i.test(word) ||
                  new RegExp(`(?:^|[^A-Za-z0-9_-])${word}(?=$|[^A-Za-z0-9_-])`, 'i').test(
                    originalPrompt,
                  )),
            );
          }).length === 1;
        explicitSourceTaskBound =
          originalTask.test(originalPrompt) &&
          explanationBound &&
          alternatives.filter((other) => other !== alternative && oneOffTask.test(other)).length ===
            1;
      }
      if (
        !simpleReference &&
        !(criterionBound && taskBound) &&
        !sourceActionBound &&
        !sourceBoundPassiveReference &&
        !explicitSourceTaskBound
      )
        return null;
      roles.push('pipeline');
    }
    if (
      new Set(roles).size !== alternatives.length ||
      !roles.includes('pipeline') ||
      !roles.some((role) => role === 'explanation' || role === 'one-off')
    )
      return null;
    return {
      text: 'Create a new pipeline for the requested task; this is a pipeline generation request.',
      authority: policy.pipelineGoalAuthority,
      criterionSha256: goal.criterionSha256,
    };
  }
  return { resolvedNewWorkspaceClarification, resolvedOriginalTestGoalClarification };
}
