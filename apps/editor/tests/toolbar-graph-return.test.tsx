import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Toolbar } from '../src/components/board/Toolbar';

const noop = () => {};

describe('Toolbar graph return control', () => {
  test('keeps Search in the toolbar without duplicating menu-owned views', () => {
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
      />,
    );

    expect(html).toContain('aria-label="Search tasks"');
    expect(html).not.toContain('title="View track / pipeline I/O"');
    expect(html).not.toContain('title="View run history"');
    expect(html).not.toContain('aria-label="Open Pipeline Graph"');
  });

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
