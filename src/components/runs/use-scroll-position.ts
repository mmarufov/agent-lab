"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type WheelEvent,
} from "react";
import { revealWithin } from "./scroll";

// Track each panel independently. New content never initiates scrolling.
export function useScrollPosition({ once = false, initialDismissed = false, onDismiss }: {
  once?: boolean;
  initialDismissed?: boolean;
  onDismiss?: (value: boolean) => void;
} = {}) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const offered = useRef(false);
  const dismissedRef = useRef(initialDismissed);
  const dismiss = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    onDismiss?.(true);
  }, [onDismiss]);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const updatePosition = useCallback(() => {
    const element = scroll.current;
    const distance = element
      ? element.scrollHeight - element.clientHeight - element.scrollTop
      : 0;
    const away = Boolean(element?.clientHeight && distance > 32);
    if (once && element?.clientHeight) {
      if (away) offered.current = true;
      else if (offered.current) dismiss();
    }
    setAwayFromBottom(away && !dismissedRef.current);
    return distance;
  }, [once, dismiss]);
  const jumpToLatest = useCallback(() => {
    const element = scroll.current;
    // The mobile results wrapper uses display: contents, not a scroll area.
    if (!element?.clientHeight) return;
    if (once) {
      dismiss();
      setAwayFromBottom(false);
    }
    element.scrollTo({
      top: element.scrollHeight,
      behavior:
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "smooth"
          : "instant",
    });
  }, [once, dismiss]);
  const interruptScroll = useCallback(() => {
    const element = scroll.current;
    if (element)
      element.scrollTo({ top: element.scrollTop, behavior: "instant" });
    updatePosition();
  }, [updatePosition]);
  const inspect = useCallback(
    (target: HTMLElement, align: "nearest" | "start" = "nearest") => {
      const element = scroll.current;
      if (!element?.clientHeight) return;
      revealWithin(element, target, align);
      updatePosition();
    },
    [updatePosition],
  );
  useEffect(() => {
    const element = scroll.current,
      contents = content.current;
    if (!element || !contents) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updatePosition);
    });
    observer.observe(element);
    observer.observe(contents);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      element.scrollTo({ top: element.scrollTop, behavior: "instant" });
    };
  }, [updatePosition]);
  return {
    scroll,
    content,
    awayFromBottom,
    jumpToLatest,
    inspect,
    handlers: {
      onScroll: updatePosition,
      onPointerDown: interruptScroll,
      onWheel: (event: WheelEvent<HTMLDivElement>) => {
        if (event.deltaY !== 0) interruptScroll();
      },
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (
          ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(
            event.key,
          )
        )
          interruptScroll();
      },
    },
  };
}
