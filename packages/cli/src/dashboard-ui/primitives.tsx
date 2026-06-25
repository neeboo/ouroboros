import type * as React from "react";

type PrimitiveElement = "aside" | "div" | "nav" | "section";

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function Button({
  className,
  variant = "default",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "secondary" | "danger" | "ghost";
}) {
  return (
    <button
      className={cx(className, "ui-button", `ui-button-${variant}`)}
      {...props}
    />
  );
}

export function Tabs({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx(className, "ui-tabs")} {...props} />;
}

export function TabsTrigger({
  active = false,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
}) {
  return (
    <button
      className={cx(className, active && "active", "ui-tabs-trigger")}
      aria-pressed={props["aria-pressed"] ?? active}
      {...props}
    />
  );
}

export function Panel({
  as: Component = "section",
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  as?: PrimitiveElement;
}) {
  return <Component className={cx(className, "ui-panel")} {...props} />;
}

export function Separator({
  className,
  decorative = true,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  decorative?: boolean;
}) {
  return (
    <div
      className={cx(className, "ui-separator")}
      role={decorative ? "presentation" : "separator"}
      {...props}
    />
  );
}

export function ScrollArea({
  as: Component = "div",
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  as?: PrimitiveElement;
}) {
  return <Component className={cx(className, "ui-scroll-area")} {...props} />;
}
