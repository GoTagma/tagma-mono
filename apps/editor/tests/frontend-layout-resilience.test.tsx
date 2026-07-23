import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PlatformExportProgressToast,
  VIEWPORT_NOTIFICATION_STACK_CLASSES,
  ViewportNotificationStack,
} from '../src/components/AppOverlays';
import { DropdownMenu } from '../src/components/DropdownMenu';
import { ERROR_TOAST_VIEWPORT_CLASSES } from '../src/components/ErrorToast';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { PipelinePicker } from '../src/components/PipelinePicker';
import { SaveAsDialog } from '../src/components/SaveAsDialog';
import {
  resolveRightDockViewportLayout,
  resolveVisibleDockState,
} from '../src/components/RightDock';
import { VERSION_STATUS_POPOVER_CLASSES } from '../src/components/VersionStatusBar';
import { buildCompactToolbarItems, Toolbar } from '../src/components/board/Toolbar';
import { CONTEXT_MENU_VIEWPORT_CLASSES } from '../src/components/board/ContextMenu';
import { PipelineSummaryBar } from '../src/components/board/PipelineSummaryBar';
import {
  BootstrapOverlay,
  CHAT_COMPLETION_TOAST_VIEWPORT_CLASSES,
} from '../src/components/chat/ChatPanel';
import { ChatComposer } from '../src/components/chat/ChatComposer';
import { computeFloatingPanelPlacement } from '../src/components/chat/FloatingPanel';
import { ConfirmModal } from '../src/components/ConfirmModal';
import { DialogModal } from '../src/components/DialogModal';
import { FileExplorer } from '../src/components/FileExplorer';
import { ConfirmDialog } from '../src/components/panels/ConfirmDialog';
import { PluginsPage } from '../src/components/plugins/PluginsPage';
import { PLUGIN_CARD_GRID_CLASSES } from '../src/components/plugins/plugin-card';
import { RunHistoryBrowser } from '../src/components/run/RunHistoryBrowser';
import { RUN_SEARCH_OVERLAY_CLASSES } from '../src/components/run/RunView';
import { TrackIODialog } from '../src/components/panels/TrackIODialog';
import { ApprovalDialog } from '../src/components/run/ApprovalDialog';
import { UsagePage } from '../src/components/usage/UsagePage';
import { WelcomePage } from '../src/components/WelcomePage';

describe('frontend layout resilience', () => {
  test('turns split dock columns into one bounded drawer on compact viewports', () => {
    expect(resolveRightDockViewportLayout(320, 720)).toEqual({
      compact: true,
      panelWidth: 288,
    });
    expect(resolveRightDockViewportLayout(24, 360)).toEqual({
      compact: true,
      panelWidth: 0,
    });
    expect(resolveRightDockViewportLayout(960, 540)).toEqual({
      compact: false,
      panelWidth: 540,
    });

    expect(resolveVisibleDockState(['chat'], 'chat', 'yaml', true)).toEqual({
      tabs: ['chat', 'yaml'],
      activeTab: 'chat',
      detachedTab: null,
    });
    expect(resolveVisibleDockState([], null, 'yaml', true)).toEqual({
      tabs: ['yaml'],
      activeTab: 'yaml',
      detachedTab: null,
    });
  });

  test('keeps plugin cards and navigation within a narrow content column', () => {
    expect(PLUGIN_CARD_GRID_CLASSES).toContain('min(100%,440px)');

    const html = renderToStaticMarkup(
      <PluginsPage
        workDir="/repo"
        declaredPlugins={[]}
        onBack={() => {}}
        onRegistryUpdate={() => {}}
        onPluginsChange={() => {}}
        onRequestBrowseLocal={() => {}}
        onRefreshServerState={() => {}}
      />,
    );

    expect(html).toContain('flex-col md:flex-row');
    expect(html).toContain('w-full shrink-0');
    expect(html).toContain('md:w-48');
    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('md:overflow-x-visible');
    expect(html).toContain('flex flex-wrap');
    expect(html).toContain('order-last w-full');
    expect(html).toContain('sm:w-64');
  });

  test('lets the usage page scroll vertically when the viewport is short', () => {
    const html = renderToStaticMarkup(<UsagePage onBack={() => {}} />);

    expect(html).toContain('overflow-y-auto');
    expect(html).toContain('h-[clamp(180px,32vh,280px)]');
    expect(html).toContain('min-h-[220px]');
    expect(html).toContain('grid-cols-1');
    expect(html).toContain('sm:grid-cols-2');
    expect(html).toContain('md:grid-cols-4');
  });

  test('clamps anchored floating panels in both dimensions', () => {
    expect(
      computeFloatingPanelPlacement({
        anchor: { left: 100, top: 100, right: 140, bottom: 120 },
        viewportWidth: 240,
        viewportHeight: 140,
        requestedWidth: 320,
        requestedMaxHeight: 320,
        zoom: 1,
      }),
    ).toEqual({ left: 6, top: 6, width: 228, maxHeight: 94 });

    const tiny = computeFloatingPanelPlacement({
      anchor: { left: 4, top: 10, right: 20, bottom: 30 },
      viewportWidth: 24,
      viewportHeight: 40,
      requestedWidth: 320,
      requestedMaxHeight: 320,
      zoom: 1,
    });
    expect(tiny.left).toBeGreaterThanOrEqual(0);
    expect(tiny.top).toBeGreaterThanOrEqual(0);
    expect(tiny.left + tiny.width).toBeLessThanOrEqual(24);
    expect(tiny.top + tiny.maxHeight).toBeLessThanOrEqual(40);
  });

  test('bounds fixed notifications, searches, and menus to the viewport', () => {
    expect(VIEWPORT_NOTIFICATION_STACK_CLASSES).toContain('gap-2');
    expect(VIEWPORT_NOTIFICATION_STACK_CLASSES).toContain('overflow-y-auto');
    expect(VIEWPORT_NOTIFICATION_STACK_CLASSES).toContain('max-h-[calc(100dvh-1rem)]');

    expect(ERROR_TOAST_VIEWPORT_CLASSES).toContain('inset-x-2');
    expect(ERROR_TOAST_VIEWPORT_CLASSES).toContain('max-h-[calc(100dvh-1rem)]');
    expect(ERROR_TOAST_VIEWPORT_CLASSES).toContain('overflow-y-auto');

    const progressToast = renderToStaticMarkup(
      <PlatformExportProgressToast
        progress={{
          targetPlatform: 'linux',
          stage: 'generating',
          detail: 'x'.repeat(2_000),
          messages: ['y'.repeat(2_000)],
        }}
      />,
    );
    expect(progressToast).toContain('inset-x-2');
    expect(progressToast).toContain('max-h-[calc(100dvh-1rem)]');
    expect(progressToast).toContain('overflow-y-auto');

    const stackedProgress = renderToStaticMarkup(
      <ViewportNotificationStack>
        <PlatformExportProgressToast
          contained
          progress={{
            targetPlatform: 'linux',
            stage: 'generating',
            detail: 'first',
            messages: [],
          }}
        />
        <PlatformExportProgressToast
          contained
          progress={{
            targetPlatform: 'windows',
            stage: 'writing',
            detail: 'second',
            messages: [],
          }}
        />
      </ViewportNotificationStack>,
    );
    expect(stackedProgress.match(/role="status"/g)).toHaveLength(2);
    expect(stackedProgress).toContain('max-h-[min(18rem,45dvh)]');

    const dropdown = renderToStaticMarkup(
      <DropdownMenu items={[]} onClose={() => {}} anchorClassName="fixed left-0 top-0" />,
    );
    expect(dropdown).toContain('min-w-[min(240px,calc(100vw-1rem))]');
    expect(dropdown).toContain('max-w-[calc(100vw-1rem)]');

    for (const classes of [
      VERSION_STATUS_POPOVER_CLASSES,
      RUN_SEARCH_OVERLAY_CLASSES,
      CHAT_COMPLETION_TOAST_VIEWPORT_CLASSES,
      CONTEXT_MENU_VIEWPORT_CLASSES,
    ]) {
      expect(classes).toContain('100vw');
      expect(classes).toMatch(/max-h|overflow-y-auto/);
    }
  });

  test('keeps editor toolbar actions reachable in compact widths', () => {
    const noop = () => {};
    const compactItems = buildCompactToolbarItems({
      menus: [
        { label: 'File', items: [{ label: 'New', onAction: noop }] },
        {
          label: 'View',
          items: [
            { label: 'Track I/O', onAction: noop },
            { label: 'Run History', onAction: noop },
          ],
        },
        {
          label: 'Graph',
          items: [{ label: 'Open Pipeline Graph', onAction: noop }],
        },
      ],
      onSelectPipeline: noop,
      onReturnToWorkflowGraph: noop,
    });
    const labels = compactItems.flatMap((item) => ('separator' in item ? [] : [item.label]));
    expect(labels).toEqual([
      'File · New',
      'View · Track I/O',
      'View · Run History',
      'Graph · Open Pipeline Graph',
      'Inspect Pipeline',
      'Go Back',
    ]);

    const html = renderToStaticMarkup(
      <Toolbar
        pipelineName={'Pipeline '.repeat(20)}
        yamlPath="/workspace/.tagma/pipeline/pipeline.yaml"
        workDir={'/workspace/'.repeat(20)}
        isDirty
        errorCount={999}
        menus={[{ label: 'File', items: [{ label: 'New', onAction: noop }] }]}
        workspaceItems={[]}
        onUpdateName={noop}
        onSelectPipeline={noop}
        onRun={noop}
        onReturnToWorkflowGraph={noop}
        searchQuery=""
        searchOpen
        searchMatches={[]}
        searchMode="name"
        onSearchOpen={noop}
        onSearchClose={noop}
        onSearchQueryChange={noop}
        onSearchModeChange={noop}
        onSelectSearchMatch={noop}
      />,
    );
    expect(html).toContain('aria-label="Open application menu"');
    expect(html).toContain('aria-label="Run pipeline"');
    expect(html).toContain('sm:hidden');
    expect(html).toContain('hidden items-center shrink-0 h-full sm:flex');
    expect(html).toContain('hidden lg:flex');
    expect(html).toContain('hidden md:flex');
    expect(html).toContain('w-[clamp(140px,26vw,320px)]');
  });

  test('stacks run history and wraps its controls on narrow viewports', () => {
    const html = renderToStaticMarkup(<RunHistoryBrowser />);
    expect(html).toContain('flex-col md:flex-row');
    expect(html).toContain('max-h-[min(16rem,40%)]');
    expect(html).toContain('md:w-72');
    expect(html).toContain('flex flex-wrap');
    expect(html).toContain('order-last w-full');
    expect(html).toContain('min-h-11');
  });

  test('gives common dialogs a short-viewport scroll contract', () => {
    const noop = () => {};
    const dialogs = [
      renderToStaticMarkup(
        <ConfirmModal
          info={{
            title: 'Confirm',
            details: ['x'.repeat(2_000)],
            confirmLabel: 'Continue',
            onConfirm: noop,
          }}
          onClose={noop}
        />,
      ),
      renderToStaticMarkup(
        <DialogModal
          info={{ type: 'error', title: 'Error', details: ['x'.repeat(2_000)] }}
          onClose={noop}
        />,
      ),
      renderToStaticMarkup(
        <SaveAsDialog defaultValue="pipeline" onConfirm={noop} onCancel={noop} />,
      ),
      renderToStaticMarkup(
        <ConfirmDialog
          title="Delete item?"
          message={'x'.repeat(2_000)}
          onConfirm={noop}
          onCancel={noop}
        />,
      ),
      renderToStaticMarkup(<FileExplorer mode="open" onConfirm={noop} onCancel={noop} />),
      renderToStaticMarkup(
        <TrackIODialog config={{ name: 'Pipeline', tracks: [] }} onClose={noop} />,
      ),
      renderToStaticMarkup(
        <ApprovalDialog
          request={{
            id: 'approval',
            taskId: 'main.task',
            trackId: 'main',
            message: 'x'.repeat(2_000),
            createdAt: '2026-07-12T00:00:00.000Z',
            timeoutMs: 60_000,
          }}
          onApprove={noop}
          onReject={noop}
        />,
      ),
    ];

    for (const html of dialogs) {
      expect(html).toContain('modal-viewport-backdrop');
      expect(html).toContain('modal-viewport-shell');
      expect(html).toContain('modal-viewport-body');
      expect(html).toContain('modal-viewport-footer');
    }
  });

  test('reserves content space when a dialog viewport is extremely short', async () => {
    const css = await Bun.file(new URL('../src/index.css', import.meta.url)).text();
    expect(css).toContain('@media (max-height: 320px)');
    expect(css).toContain('.modal-viewport-shell > .panel-header');
    expect(css).toContain('padding-top: 0.5rem !important');
  });

  test('keeps welcome, picker, and fatal-error actions reachable on short screens', () => {
    const noop = () => {};
    const welcome = renderToStaticMarkup(
      <WelcomePage onOpenWorkspace={noop} onSelectRecent={noop} />,
    );
    expect(welcome).toContain('overflow-y-auto');
    expect(welcome).toContain('px-4 sm:px-8');

    const picker = renderToStaticMarkup(
      <PipelinePicker
        workDir="/workspace"
        workspaceYamls={[]}
        yamlEditLocked={false}
        onPickPipeline={noop}
        onCreateNew={noop}
        onSwitchWorkspace={noop}
        onDeletePipeline={noop}
      />,
    );
    expect(picker).toContain('px-4 sm:px-8');
    expect(picker).toContain('max-h-[min(55dvh,20rem)]');

    const boundary = new ErrorBoundary({ children: null });
    boundary.state = { hasError: true, error: new Error('x'.repeat(2_000)) };
    const fatal = renderToStaticMarkup(boundary.render());
    expect(fatal).toContain('overflow-y-auto');
    expect(fatal).toContain('min-h-full');
    expect(fatal).toContain('flex-wrap');
  });

  test('lets dense run and version controls collapse without horizontal overflow', async () => {
    const [runView, versionStatus] = await Promise.all([
      Bun.file(new URL('../src/components/run/RunView.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src/components/VersionStatusBar.tsx', import.meta.url)).text(),
    ]);

    expect(runView).toContain('hidden items-center gap-1 lg:flex');
    expect(runView).toContain('absolute right-2 top-full');
    expect(versionStatus).toContain('grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]');
    expect(versionStatus).toContain('flex flex-wrap items-center gap-2 pt-1');
  });

  test('keeps compact canvas summaries and chat composition inside their panel', () => {
    const summary = renderToStaticMarkup(
      <PipelineSummaryBar
        config={{
          name: 'Pipeline',
          driver: 'a-very-long-custom-driver-name-that-must-scroll',
          timeout: '100000 minutes',
          plugins: ['one', 'two', 'three'],
          hooks: { pipeline_start: 'echo before', task_start: 'echo task' },
          tracks: [{ id: 'main', name: 'Main', tasks: [] }],
        }}
      />,
    );
    expect(summary).toContain('px-2 sm:px-[44px]');
    expect(summary).toContain('overflow-x-auto');
    expect(summary).toContain('hide-scrollbar');
    expect(summary).toContain('hidden sm:inline');

    const composer = renderToStaticMarkup(<ChatComposer />);
    expect(composer).toContain('min-w-0 flex-1');
    expect(composer).toContain('shrink-0 p-1.5');

    const bootstrap = renderToStaticMarkup(<BootstrapOverlay />);
    expect(bootstrap).toContain('overflow-y-auto');
    expect(bootstrap).toContain('min-h-full');
  });
});
