"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type RefCallback,
} from "react";

type Tab = {
  id: string;
  label: string;
};

type PanelProps = HTMLAttributes<HTMLElement> & {
  ref: RefCallback<HTMLElement>;
  "data-state": "active" | "inactive";
};

type TabsRenderArgs = {
  activeTab: string;
  isMounted: (tabId: string) => boolean;
  getPanelProps: (tabId: string) => PanelProps;
};

type TabsProps = {
  tabs: Tab[];
  defaultTab?: string;
  ariaLabel: string;
  children: (args: TabsRenderArgs) => React.ReactNode;
};

const HEIGHT_TRANSITION_FALLBACK_MS = 180;

export function Tabs({ tabs, defaultTab, ariaLabel, children }: TabsProps) {
  const fallbackTab = tabs[0]?.id ?? "";
  const initialTab = defaultTab ?? fallbackTab;
  const [activeTabState, setActiveTabState] = useState(initialTab);
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(
    () => new Set(initialTab ? [initialTab] : []),
  );
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const baseId = useId();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const panelRefs = useRef<Record<string, HTMLElement | null>>({});
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const transitionTimerRef = useRef<number | null>(null);
  const activeTab = tabs.some((tab) => tab.id === activeTabState)
    ? activeTabState
    : initialTab;

  const resolvedVisitedTabs = useMemo(() => {
    if (!activeTab || visitedTabs.has(activeTab)) {
      return visitedTabs;
    }
    const next = new Set(visitedTabs);
    next.add(activeTab);
    return next;
  }, [activeTab, visitedTabs]);

  const activateTab = useCallback((tabId: string) => {
    setActiveTabState(tabId);
    setVisitedTabs((current) => {
      if (current.has(tabId)) {
        return current;
      }
      const next = new Set(current);
      next.add(tabId);
      return next;
    });
  }, []);

  const focusTab = useCallback((tabId: string) => {
    tabRefs.current[tabId]?.focus();
  }, []);

  const updateHeight = useCallback(() => {
    if (!activeTab) return;
    const panel = panelRefs.current[activeTab];
    if (!panel) return;
    setMeasuredHeight(panel.getBoundingClientRect().height);
  }, [activeTab]);

  useLayoutEffect(() => {
    updateHeight();
  }, [activeTab, updateHeight, visitedTabs]);

  useEffect(() => {
    if (!activeTab) return;
    const panel = panelRefs.current[activeTab];
    if (!panel || typeof ResizeObserver === "undefined") {
      updateHeight();
      return;
    }

    resizeObserverRef.current?.disconnect();
    const observer = new ResizeObserver(() => {
      updateHeight();
    });
    observer.observe(panel);
    resizeObserverRef.current = observer;

    return () => {
      observer.disconnect();
      if (resizeObserverRef.current === observer) {
        resizeObserverRef.current = null;
      }
    };
  }, [activeTab, updateHeight]);

  useEffect(() => {
    return () => {
      resizeObserverRef.current?.disconnect();
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current);
      }
    };
  }, []);

  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);

  const moveFocus = useCallback(
    (currentId: string, direction: "next" | "prev" | "first" | "last") => {
      const index = tabIds.indexOf(currentId);
      if (index === -1 || tabIds.length === 0) return;

      let nextIndex = index;
      if (direction === "next") {
        nextIndex = (index + 1) % tabIds.length;
      } else if (direction === "prev") {
        nextIndex = (index - 1 + tabIds.length) % tabIds.length;
      } else if (direction === "first") {
        nextIndex = 0;
      } else if (direction === "last") {
        nextIndex = tabIds.length - 1;
      }

      const nextTabId = tabIds[nextIndex];
      activateTab(nextTabId);
      focusTab(nextTabId);
    },
    [activateTab, focusTab, tabIds],
  );

  const getTabButtonId = useCallback(
    (tabId: string) => `${baseId}-tab-${tabId}`,
    [baseId],
  );

  const getPanelId = useCallback(
    (tabId: string) => `${baseId}-panel-${tabId}`,
    [baseId],
  );

  const getPanelProps = useCallback(
    (tabId: string): PanelProps => ({
      id: getPanelId(tabId),
      ref: (node: HTMLElement | null) => {
        panelRefs.current[tabId] = node;
        if (tabId === activeTab && node) {
          setMeasuredHeight(node.getBoundingClientRect().height);
        }
      },
      role: "tabpanel",
      "aria-labelledby": getTabButtonId(tabId),
      "aria-hidden": activeTab === tabId ? undefined : true,
      "data-state": activeTab === tabId ? "active" : "inactive",
      className: "tab-panel",
    }),
    [activeTab, getPanelId, getTabButtonId],
  );

  const tabPanelsStyle = measuredHeight !== null
    ? { height: `${Math.ceil(measuredHeight)}px` }
    : undefined;

  useEffect(() => {
    if (measuredHeight === null) return;
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
    }
    transitionTimerRef.current = window.setTimeout(() => {
      transitionTimerRef.current = null;
    }, HEIGHT_TRANSITION_FALLBACK_MS);
  }, [measuredHeight]);

  return (
    <div className="tabs-root">
      <nav className="tab-list" role="tablist" aria-label={ariaLabel}>
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={getTabButtonId(tab.id)}
              ref={(node) => {
                tabRefs.current[tab.id] = node;
              }}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={getPanelId(tab.id)}
              tabIndex={isActive ? 0 : -1}
              data-active={isActive ? "true" : undefined}
              className="tab-trigger"
              onClick={() => activateTab(tab.id)}
              onKeyDown={(event) => {
                switch (event.key) {
                  case "ArrowRight":
                  case "ArrowDown":
                    event.preventDefault();
                    moveFocus(tab.id, "next");
                    break;
                  case "ArrowLeft":
                  case "ArrowUp":
                    event.preventDefault();
                    moveFocus(tab.id, "prev");
                    break;
                  case "Home":
                    event.preventDefault();
                    moveFocus(tab.id, "first");
                    break;
                  case "End":
                    event.preventDefault();
                    moveFocus(tab.id, "last");
                    break;
                  default:
                    break;
                }
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>
      <div className="tab-panels" style={tabPanelsStyle}>
        {children({
          activeTab,
          isMounted: (tabId) => resolvedVisitedTabs.has(tabId),
          getPanelProps,
        })}
      </div>
    </div>
  );
}
