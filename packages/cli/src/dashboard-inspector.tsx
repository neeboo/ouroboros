import { Button, Panel, ScrollArea, Separator } from "./dashboard-ui/primitives";

export function ConversationTimeline({
  children,
}: {
  children?: React.ReactNode;
}) {
  return (
    <Panel
      className="inspector-card conversation-timeline-section"
      data-inspector-section="conversation"
      id="conversation-timeline"
      data-conversation-timeline
    >
      <h2>Conversation</h2>
      <div className="conversation-timeline-meta">Chronological session timeline · oldest first.</div>
      <ScrollArea className="conversation-timeline-scroll" data-conversation-timeline-scroll>
        {children}
      </ScrollArea>
    </Panel>
  );
}

export function InspectorComposer() {
  return (
    <Panel
      className="inspector-card inspector-composer-section"
      data-inspector-section="composer"
      id="inspector-composer-section"
      data-inspector-composer-section
    >
      <h2>Composer</h2>
      <form className="inspector-composer" id="inspector-composer" data-inspector-composer-form>
        <textarea
          id="inspector-composer-input"
          name="prompt"
          className="inspector-composer-input"
          rows={2}
          placeholder="Reply or direct the next step"
          aria-label="Inspector composer"
        />
        <div className="inspector-composer-actions">
          <span className="inspector-composer-hint">Enter sends via the intake planner.</span>
          <Button type="submit" data-inspector-composer-send>
            Send
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
