import { test, expect } from 'bun:test';
import { createClarificationPolicyResolvers } from '../chat-clarification-policy.mjs';

const trusted = {
  expectedSourceSha: 'a'.repeat(64),
  requiredNewWorkspaceAuthority: 'user-authorized-new-workspace',
  requiredGoalAuthority: 'user-authorized-pipeline-generation',
};
const { resolvedNewWorkspaceClarification: named, resolvedOriginalTestGoalClarification: goal } =
  createClarificationPolicyResolvers(trusted);
function fixture() {
  const operation = {
    operationId: 'active-operation',
    generation: 4,
    version: 9,
    executionState: 'waiting_for_user',
  };
  const pending = {
    kind: 'clarification',
    operationId: operation.operationId,
    generation: operation.generation,
    operationVersion: operation.version,
    clarificationId: 'active-clarification',
    question: 'Should I create a new pipeline named sample.yaml, or edit the existing pipeline?',
    candidates: [],
  };
  const policy = {
    newWorkspaceNamedPipeline: 'create_new',
    newWorkspaceAuthority: trusted.requiredNewWorkspaceAuthority,
    pipelineGoalAuthority: trusted.requiredGoalAuthority,
    originalTestPipelineGoals: [
      {
        caseId: 'requested-case',
        goal: 'pipeline_generation',
        sourceSha256: trusted.expectedSourceSha,
        criterion: 'Generate a working pipeline.',
        criterionSha256: 'b'.repeat(64),
      },
    ],
  };
  return { operation, pending, policy, original: 'Create sample.yaml for the requested task.' };
}
function namedAnswer(x) {
  return named(x.pending, x.operation, x.original, x.policy);
}
function goalAnswer(x) {
  return goal(x.pending, x.operation, x.policy, 'requested-case', x.original);
}
function intentFixture() {
  const x = fixture();
  x.pending.question =
    'Do you want an explanation, a one-off action, or a pipeline change to set this up?';
  return x;
}

test('portable clarification accepts named and located new pipeline alternatives', () => {
  for (const question of [
    'Create a new pipeline at "sample.yaml", or modify the existing current-canvas draft "Blank Pipeline"?',
    'Should I create a new pipeline named sample.yaml, or edit the existing pipeline instead?',
    'Do you want this pipeline created as a brand-new pipeline named sample.yaml, or should it replace/update the current-canvas Blank Pipeline draft?',
    'Should I create it as a new pipeline (`sample.yaml`), or put this into the current blank canvas draft?',
    'Should I create this as a new pipeline (sample.yaml), or build it into the current untitled canvas draft? The request names a file that does not match the inventoried pipeline.',
  ]) {
    const x = fixture();
    x.pending.question = question;
    expect(namedAnswer(x)).toEqual({
      text: 'Create the new pipeline at the requested filename; do not modify the default blank draft.',
      requestedFilename: 'sample.yaml',
      authority: trusted.requiredNewWorkspaceAuthority,
    });
  }
});

test('portable clarification requires exact filename and current authority', () => {
  for (const mutate of [
    (x) => {
      x.original = 'Create other.yaml.';
    },
    (x) => {
      x.original = 'Create old_sample.yaml.';
    },
    (x) => {
      x.original = 'Create sample.yaml.backup.';
    },
    (x) => {
      x.original = 'Create folder/sample.yaml.';
    },
    (x) => {
      x.original = 'Create folder\\sample.yaml.';
    },
    (x) => {
      x.pending.operationId = 'previous-operation';
    },
    (x) => {
      x.pending.generation--;
    },
    (x) => {
      x.pending.operationVersion--;
    },
    (x) => {
      delete x.pending.clarificationId;
    },
    (x) => {
      x.operation.executionState = 'terminal';
    },
    (x) => {
      delete x.policy.newWorkspaceAuthority;
    },
    (x) => {
      x.policy.newWorkspaceAuthority = 'self-declared-authority';
    },
    (x) => {
      x.policy.newWorkspaceNamedPipeline = 'edit_existing';
    },
  ]) {
    const x = fixture();
    mutate(x);
    expect(namedAnswer(x)).toBeNull();
  }
});

test('portable clarification rejects mixed named questions and populated candidates', () => {
  for (const question of [
    'Create a new pipeline named sample.yaml or other.yaml, or edit the existing pipeline?',
    'Create a new pipeline named sample.yaml, or edit the existing pipeline and delete all data?',
    'Create a new pipeline named sample.yaml, or edit the existing pipeline? Also should I export credentials?',
    'Create this as a new pipeline (sample.yaml), or build it into the current blank canvas draft? Export credentials.',
    'Create this as a new pipeline (sample.yaml), or build it into the current blank canvas draft? The request names a file that does not match the inventoried pipeline and delete data.',
  ]) {
    const x = fixture();
    x.pending.question = question;
    expect(namedAnswer(x)).toBeNull();
  }
  const x = fixture();
  x.pending.candidates = [{ candidateId: 'existing-pipeline' }];
  expect(namedAnswer(x)).toBeNull();
});

test('portable clarification accepts three distinct intent alternatives in any order', () => {
  for (const question of [
    'Do you want an explanation, a one-off action, or a pipeline change (new or edited pipeline) to set this up?',
    'Do you want a one-off action, an explanation, or a change to a pipeline that performs it?',
    'Would you like a pipeline change; an explanation; or a one-off action?',
    'Are you asking for a new or edited pipeline, a one-off action, or an overview?',
    'Do you want an explanation or a pipeline change?',
    'Do you want a one-off action or a new pipeline?',
  ]) {
    const x = intentFixture();
    x.pending.question = question;
    expect(goalAnswer(x)).toEqual({
      text: 'Create a new pipeline for the requested task; this is a pipeline generation request.',
      authority: trusted.requiredGoalAuthority,
      criterionSha256: 'b'.repeat(64),
    });
  }
  for (const question of [
    'Do you want a one-off report now, or a reusable pipeline that performs this Widget-based report?',
    'Do you want a reusable pipeline that performs this Widget-based report, or an explanation of the report?',
  ]) {
    const x = intentFixture();
    x.pending.question = question;
    x.policy.originalTestPipelineGoals[0].criterion = 'Generate a working pipeline using Widget.';
    x.original = 'Create a pipeline for this Widget-based report.';
    expect(goalAnswer(x)?.authority).toBe(trusted.requiredGoalAuthority);
  }
});

test('portable clarification requires source bound goal and current identity', () => {
  for (const mutate of [
    (x) => {
      x.policy.originalTestPipelineGoals[0].sourceSha256 = 'c'.repeat(64);
    },
    (x) => {
      x.policy.originalTestPipelineGoals[0].caseId = 'another-case';
    },
    (x) => {
      x.policy.originalTestPipelineGoals[0].criterion = 'Return an accuracy score.';
    },
    (x) => {
      x.policy.originalTestPipelineGoals[0].criterionSha256 = 'invalid';
    },
    (x) => {
      x.policy.originalTestPipelineGoals = [];
    },
    (x) => {
      delete x.policy.pipelineGoalAuthority;
    },
    (x) => {
      x.policy.pipelineGoalAuthority = 'self-declared-authority';
    },
    (x) => {
      x.pending.operationId = 'previous-operation';
    },
    (x) => {
      x.pending.generation--;
    },
    (x) => {
      x.pending.operationVersion--;
    },
    (x) => {
      delete x.pending.clarificationId;
    },
    (x) => {
      x.pending.kind = 'permission';
    },
    (x) => {
      x.operation.executionState = 'terminal';
    },
    (x) => {
      x.pending.candidates = [{ candidateId: 'another-intent' }];
    },
  ]) {
    const x = intentFixture();
    mutate(x);
    expect(goalAnswer(x)).toBeNull();
  }
});

test('portable clarification rejects unrelated or ambiguous intent alternatives', () => {
  for (const question of [
    'Do you want a strict mathematical score for the pipeline?',
    'Do you want an explanation or a one-off action?',
    'Do you want a pipeline change or a reusable pipeline?',
    'Do you want an explanation, a one-off action, a pipeline change, or another business rule?',
    'Do you want an explanation, another explanation, or a pipeline change?',
    'Do you want an explanation, a one-off action, or a pipeline change (and export credentials)?',
    'Do you want an explanation, a one-off action, or a pipeline change (new or edited pipeline) to export credentials?',
    'Do you want an explanation, a one-off action, or a pipeline change: enforce a stricter accuracy score?',
    'Do you want an explanation, a one-off action, or a pipeline change to set this up and delete data?',
    'Do you want an explanation, a one-off action, or a pipeline change? Should I also export credentials?',
    'Do you want an explanation, a one-off action, or a pipeline change (new or edited pipeline?',
  ]) {
    const x = intentFixture();
    x.pending.question = question;
    expect(goalAnswer(x)).toBeNull();
  }
  for (const mutate of [
    (x) => {
      x.pending.question = x.pending.question.replace('Widget-based', 'Foreign-based');
    },
    (x) => {
      x.policy.originalTestPipelineGoals[0].criterion = 'Generate a pipeline using OldWidget.';
    },
    (x) => {
      x.original = 'Create a reporting pipeline using Widget.';
    },
    (x) => {
      delete x.original;
    },
    (x) => {
      x.pending.question =
        'Do you want a one-off action, or a reusable pipeline that performs this Widget-based report?';
    },
    (x) => {
      x.pending.question =
        'Do you want a one-off report, or a reusable pipeline that performs this Widget-based report and delete data?';
    },
    (x) => {
      x.pending.question =
        'Do you want a one-off report, or a reusable pipeline that performs this Widget-based report to enforce a stricter score?';
    },
  ]) {
    const x = intentFixture();
    x.pending.question =
      'Do you want a one-off report, or a reusable pipeline that performs this Widget-based report?';
    x.policy.originalTestPipelineGoals[0].criterion = 'Generate a working pipeline using Widget.';
    x.original = 'Create a pipeline for this Widget-based report.';
    mutate(x);
    expect(goalAnswer(x)).toBeNull();
  }
});

test('portable clarification requires independent caller source and authority configuration', () => {
  for (const options of [
    undefined,
    { ...trusted, expectedSourceSha: 'invalid' },
    { ...trusted, requiredNewWorkspaceAuthority: '' },
    { ...trusted, requiredGoalAuthority: '' },
  ])
    expect(() => createClarificationPolicyResolvers(options)).toThrow(TypeError);
  const mutable = { ...trusted };
  const resolvers = createClarificationPolicyResolvers(mutable);
  mutable.requiredNewWorkspaceAuthority = 'self-declared-authority';
  const x = fixture();
  x.policy.newWorkspaceAuthority = mutable.requiredNewWorkspaceAuthority;
  expect(
    resolvers.resolvedNewWorkspaceClarification(x.pending, x.operation, x.original, x.policy),
  ).toBeNull();
});

// Generic finite regressions; original test-set content is not included here.
test('portable clarification binds described workflow into current canvas comparison', () => {
  const x = fixture();
  x.original = 'Build an inspection workflow in sample.yaml.';
  x.pending.question =
    'Should I create a new pipeline named sample.yaml, or build this inspection workflow into the existing current-canvas pipeline?';
  expect(namedAnswer(x)?.requestedFilename).toBe('sample.yaml');
  for (const mutate of [
    (y) => {
      y.original = 'Build an unrelated workflow in sample.yaml.';
    },
    (y) => {
      y.pending.question = y.pending.question.replace(
        'inspection workflow',
        'inspection workflow and delete files',
      );
    },
    (y) => {
      y.pending.question += ' Should I export other data?';
    },
    (y) => {
      y.pending.generation++;
    },
    (y) => {
      y.pending.operationVersion--;
    },
    (y) => {
      y.pending.candidates = [{ candidateId: 'unapproved' }];
    },
    (y) => {
      delete y.policy.newWorkspaceAuthority;
    },
    (y) => {
      y.original = 'Build an inspection workflow in other.yaml.';
    },
  ]) {
    const y = structuredClone(x);
    mutate(y);
    expect(namedAnswer(y)).toBeNull();
  }
});

test('portable clarification binds selected action subject and method to original source', () => {
  const x = intentFixture();
  x.original = 'I want to inspect a document file in the editor using Widget.';
  x.policy.originalTestPipelineGoals[0].criterion = 'Generate a working pipeline using Widget.';
  x.pending.question =
    'Do you want a one-off inspect action on that document now, or a reusable pipeline that inspects a document file using Widget?';
  expect(goalAnswer(x)?.authority).toBe(trusted.requiredGoalAuthority);
  for (const mutate of [
    (y) => {
      y.pending.question = y.pending.question.replace('using Widget?', 'using Other?');
    },
    (y) => {
      y.original = y.original.replace('document file', 'document and separate file');
    },
    (y) => {
      y.original = y.original.replace('inspect', 'format');
    },
    (y) => {
      y.original = 'I want to inspect a document file in the Widget editor using Other.';
    },
    (y) => {
      y.policy.originalTestPipelineGoals[0].criterion = 'Generate a pipeline using OldWidget.';
    },
    (y) => {
      y.pending.question = y.pending.question.replace(
        'using Widget?',
        'using Widget and delete other data?',
      );
    },
    (y) => {
      y.pending.operationId = 'foreign-operation';
    },
    (y) => {
      delete y.policy.pipelineGoalAuthority;
    },
    (y) => {
      y.pending.candidates = [{ candidateId: 'unapproved' }];
    },
  ]) {
    const y = structuredClone(x);
    mutate(y);
    expect(goalAnswer(y)).toBeNull();
  }
});

test('portable clarification binds binary passive choice and repeated intent to original source', () => {
  const x = intentFixture();
  x.original = 'Inspect an entire draft document file in the editor using Widget.';
  x.policy.originalTestPipelineGoals[0].criterion =
    'Produces a pipeline accepting a document file path.';
  x.pending.question =
    'Do you want this draft document file inspected as a one-off action using Widget, or do you want a reusable pipeline built to do it?';
  expect(goalAnswer(x)?.authority).toBe(trusted.requiredGoalAuthority);
  for (const mutate of [
    (y) => {
      y.pending.question = y.pending.question.replace('using Widget', 'using editor');
    },
    (y) => {
      y.pending.question = y.pending.question.replace('draft document file', 'draft file');
    },
    (y) => {
      y.pending.question = y.pending.question.replace('inspected', 'deleted');
    },
    (y) => {
      y.pending.question = y.pending.question.replace(
        'built to do it',
        'built to do it and export data',
      );
    },
    (y) => {
      y.pending.question = y.pending.question.replace(', or do you want', '? Do you want');
    },
    (y) => {
      y.pending.question = y.pending.question.replace(', or do you want', ', do you want');
    },
    (y) => {
      y.pending.question = y.pending.question
        .replace('or do you want', 'or')
        .replace('?', ', or an explanation and delete files?');
    },
    (y) => {
      y.pending.operationVersion--;
    },
    (y) => {
      delete y.policy.pipelineGoalAuthority;
    },
    (y) => {
      y.pending.candidates = [{ candidateId: 'unapproved' }];
    },
  ]) {
    const y = structuredClone(x);
    mutate(y);
    expect(goalAnswer(y)).toBeNull();
  }
});

test('portable clarification binds three role deictic task to explicit original task', () => {
  const x = intentFixture();
  x.original = 'Review the report using Widget.';
  x.policy.originalTestPipelineGoals[0].criterion =
    'Produces a pipeline accepting a document file path.';
  x.pending.question =
    'Do you want an explanation of reviewing the report, a one-off review performed for you now, or a new pipeline that performs this review?';
  expect(goalAnswer(x)?.authority).toBe(trusted.requiredGoalAuthority);
  for (const mutate of [
    (y) => {
      y.pending.question = y.pending.question.replace(
        'an explanation of reviewing the report',
        'an explanation and delete all data',
      );
    },
    (y) => {
      y.pending.question = y.pending.question.replace(
        'an explanation of reviewing the report',
        'an explanation of how to review the report and delete all data',
      );
    },
    (y) => {
      y.pending.question = y.pending.question.replace(
        'an explanation of reviewing the report',
        'an explanation of how to review private records',
      );
    },
    (y) => {
      y.original = 'Format the report using Widget.';
    },
    (y) => {
      y.original = 'Format the report and retain the review note using Widget.';
    },
    (y) => {
      y.pending.question = y.pending.question.replaceAll('review', 'inspect');
    },
    (y) => {
      y.pending.question = y.pending.question.replace('one-off review', 'one-off format');
    },
    (y) => {
      y.pending.question = y.pending.question.replace(
        'review performed',
        'review and delete data performed',
      );
    },
    (y) => {
      y.pending.question = y.pending.question.replace(
        'this review?',
        'this review and delete data?',
      );
    },
    (y) => {
      y.pending.question =
        'Do you want a one-off review performed for you now, or a new pipeline that performs this review?';
    },
    (y) => {
      y.pending.question = y.pending.question.replace('a new pipeline', 'a pipeline');
    },
    (y) => {
      y.pending.question += ' Should I export other data?';
    },
    (y) => {
      y.pending.operationVersion--;
    },
    (y) => {
      y.pending.candidates = [{ candidateId: 'unapproved' }];
    },
    (y) => {
      delete y.policy.pipelineGoalAuthority;
    },
  ]) {
    const y = structuredClone(x);
    mutate(y);
    expect(goalAnswer(y)).toBeNull();
  }
});
