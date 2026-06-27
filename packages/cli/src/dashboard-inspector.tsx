import { Button, Panel, ScrollArea, Separator } from "./dashboard-ui/primitives";

export function ConversationTimeline({
  children,
}: {
  children?: React.ReactNode;
}) {
  return (
    <Panel
      className="inspector-card chat-transcript-section"
      data-inspector-section="conversation"
      id="conversation-timeline"
      data-conversation-timeline
      data-chat-transcript
    >
      <h2>Chat</h2>
      <div className="chat-transcript-meta">Codex-style agent conversation · oldest first.</div>
      <ScrollArea className="chat-transcript-scroll" data-conversation-timeline-scroll data-chat-transcript-scroll>
        {children}
      </ScrollArea>
    </Panel>
  );
}

export function ChatMessagePartItem({
  type,
  state,
  label,
  text,
}: {
  type: string;
  state: string;
  label?: string;
  text?: string;
}) {
  return (
    <div className={`chat-part chat-part-${type} chat-part-state-${state}`} data-chat-part-type={type} data-chat-part-state={state}>
      {label ? <span className="chat-part-label">{label}</span> : null}
      {text ? <span className="chat-part-text">{text}</span> : null}
    </div>
  );
}

export function InspectorComposer({
  status = "",
  mode = "intake",
}: {
  status?: string;
  mode?: "interrupt" | "intake";
}) {
  const placeholder = mode === "interrupt"
    ? "Interrupt the active run with a new instruction"
    : "Describe the next goal or change request";
  const hint = mode === "interrupt"
    ? "Cmd/Ctrl+Enter interrupts the active run · Shift+Enter for newline"
    : "Cmd/Ctrl+Enter sends via intake · Shift+Enter for newline";
  return (
    <Panel
      className="inspector-card inspector-composer-section"
      data-inspector-section="composer"
      id="inspector-composer-section"
      data-inspector-composer-section
      data-composer-mode={mode}
    >
      <h2>Composer</h2>
      <form className="inspector-composer" id="inspector-composer" data-inspector-composer-form>
        <textarea
          id="inspector-composer-input"
          name="prompt"
          className="inspector-composer-input"
          rows={2}
          placeholder={placeholder}
          aria-label="Inspector composer"
        />
        <div className="inspector-composer-actions">
          <span className="inspector-composer-hint" data-composer-mode-hint>{hint}</span>
          <span className="inspector-composer-status" id="inspector-composer-status" data-composer-status aria-live="polite">
            {status}
          </span>
          <Button type="submit" data-inspector-composer-send data-composer-send>
            {mode === "interrupt" ? "Interrupt" : "Send"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

export function RunEvidenceDisclosure({
  children,
}: {
  children?: React.ReactNode;
}) {
  return (
    <Panel
      className="inspector-card inspector-evidence-disclosure"
      data-inspector-section="run-evidence"
      data-secondary-evidence
    >
      <details>
        <summary className="inspector-evidence-summary" data-secondary-evidence-summary>
          Run evidence
        </summary>
        <div className="inspector-evidence-body" data-secondary-evidence-body>
          <Separator className="inspector-separator" />
          {children}
        </div>
      </details>
    </Panel>
  );
}

export function DashboardInspector({
  children,
}: {
  children?: React.ReactNode;
}) {
  return (
    <ScrollArea as="aside" className="inspector-panel" id="inspector-panel">
      <ConversationTimeline />
      <InspectorComposer />
      <RunEvidenceDisclosure>{children}</RunEvidenceDisclosure>
    </ScrollArea>
  );
}
