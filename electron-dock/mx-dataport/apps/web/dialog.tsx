import React, { Children, isValidElement, useLayoutEffect, useState } from "react";
import {
  DialogContent as BaseDialogContent,
  DialogHeader,
} from "@/components/ui/dialog";

export {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

// Keep the frame and close control outside the scrolling body. The visual
// viewport also accounts for the on-screen keyboard without changing page zoom.
export function DialogContent({
  children,
  className = "",
  style,
  ...props
}: React.ComponentProps<typeof BaseDialogContent>) {
  const [viewport, setViewport] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    const visible = window.visualViewport;
    const update = () => {
      const height = visible?.height ?? window.innerHeight;
      setViewport({
        "--dp-dialog-viewport-height": `${height}px`,
        "--dp-dialog-center-y": `${(visible?.offsetTop ?? 0) + height / 2}px`,
      } as React.CSSProperties);
    };
    update();
    visible?.addEventListener("resize", update);
    visible?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      visible?.removeEventListener("resize", update);
      visible?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  const auth = className.split(/\s+/).includes("auth-dialog");
  const parts = Children.toArray(children);
  const header = parts.filter(
    (child) => isValidElement(child) && child.type === DialogHeader,
  );
  const body = parts.filter(
    (child) => !isValidElement(child) || child.type !== DialogHeader,
  );
  return (
    <BaseDialogContent
      {...props}
      className={`dp-viewport-dialog ${className}`}
      style={{ ...viewport, ...style }}
    >
      {auth ? (
        children
      ) : (
        <>
          {header}
          <div className="dp-dialog-body">{body}</div>
        </>
      )}
    </BaseDialogContent>
  );
}
