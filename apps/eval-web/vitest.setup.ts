// Tests that render components need React's act environment declared.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// JSDOM 26 lacks PointerEvent; shared controls dispatch mouse-compatible click events through it.
if (typeof window !== "undefined") window.PointerEvent = window.MouseEvent as typeof PointerEvent;
