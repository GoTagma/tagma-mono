import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Toolbar } from '../src/components/board/Toolbar';

const noop = () => {};

describe('Toolbar graph return control', () => {
  test('renders Go Back only when a graph return handler is provided', () => {
    const html = renderToStaticMarkup(
      <Toolbar
        pipelineName="Build"
        yamlPath="E:/repo/.tagma/build/build.yaml"
        workDir="E:/repo"
        isDirty={false}
        errorCount={0}
        menus={[]}
        workspaceItems={[]}
        onUpdateName={noop}
        onSelectPipeline={noop}
        onRun={noop}
        onShowHistory={noop}
        onShowWorkflowGraph={noop}
        onShowTrackIO={noop}
        searchQuery=""
        searchOpen={false}
        searchMatches={[]}
        searchMode="name"
        onSearchOpen={noop}
        onSearchClose={noop}
        onSearchQueryChange={noop}
        onSearchModeChange={noop}
        onSelectSearchMatch={noop}
        onReturnToWorkflowGraph={noop}
      />,
    );

    expect(html).toContain('Go Back');
    expect(html).toContain('aria-label="Go back to Pipeline Graph"');
  });
});
