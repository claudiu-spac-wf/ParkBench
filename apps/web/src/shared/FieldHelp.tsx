import React, { useEffect, useRef, useState } from "react";

type HelpContextValue = { openId: string | undefined; setOpenId: (id?: string) => void };
const HelpContext = React.createContext(undefined as HelpContextValue | undefined);

export function FieldHelpProvider({ children }: { children: React.ReactNode }) {
  const [openId, setOpenId] = useState(undefined as string | undefined);
  return <HelpContext.Provider value={{ openId, setOpenId }}>{children}</HelpContext.Provider>;
}

export function FieldHelp({ label, children }: { label: string; children: React.ReactNode }) {
  const context = React.useContext(HelpContext);
  const local = useState(undefined as string | undefined);
  const openId = context?.openId ?? local[0];
  const setOpenId = context?.setOpenId ?? local[1];
  const generatedId = React.useId();
  const tooltipId = `field-help-${generatedId.replace(/:/g, "")}`;
  const root = useRef(null as HTMLSpanElement | null);
  const popover = useRef(null as HTMLSpanElement | null);
  const closeTimer = useRef(undefined as number | undefined);
  const focused = useRef(false);
  const position = useState(undefined as { left: number; top: number } | undefined);
  const open = openId === tooltipId;

  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      const trigger = root.current?.querySelector(".field-help-trigger") as HTMLElement | null;
      const tip = popover.current;
      if (!trigger || !tip) return;
      const triggerBox = trigger.getBoundingClientRect();
      const tipBox = tip.getBoundingClientRect();
      const gutter = 8;
      const left = Math.max(
        gutter,
        Math.min(triggerBox.left, window.innerWidth - tipBox.width - gutter)
      );
      const below = triggerBox.bottom + gutter;
      const above = triggerBox.top - tipBox.height - gutter;
      const preferredTop = below + tipBox.height <= window.innerHeight - gutter ? below : above;
      const top = Math.max(
        gutter,
        Math.min(preferredTop, window.innerHeight - tipBox.height - gutter)
      );
      position[1]({ left, top });
    };
    const frame = window.requestAnimationFrame(reposition);
    const observer = new ResizeObserver(reposition);
    if (popover.current) observer.observe(popover.current);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpenId(undefined);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenId(undefined);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [open, setOpenId]);

  const show = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    setOpenId(tooltipId);
  };
  const hide = () => {
    if (focused.current) return;
    closeTimer.current = window.setTimeout(() => setOpenId(undefined), 120);
  };

  const focus = () => {
    focused.current = true;
    show();
  };

  const blur = () => {
    focused.current = false;
    hide();
  };

  return (
    <span className="field-help" ref={root} onMouseEnter={show} onMouseLeave={hide}>
      <button
        type="button"
        className="field-help-trigger"
        aria-label={`Help for ${label}`}
        aria-expanded={open}
        aria-describedby={open ? tooltipId : undefined}
        onFocus={focus}
        onBlur={blur}
        onClick={show}
      >
        i
      </button>
      {open && (
        <span
          id={tooltipId}
          className="field-help-popover"
          role="tooltip"
          ref={popover}
          style={
            position[0]
              ? { position: "fixed", left: position[0].left, top: position[0].top }
              : undefined
          }
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          {children}
        </span>
      )}
    </span>
  );
}

export function HelpLabel({
  label,
  help,
  children
}: {
  label: string;
  help: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="field-label">
      {children ?? label} <FieldHelp label={label}>{help}</FieldHelp>
    </span>
  );
}
