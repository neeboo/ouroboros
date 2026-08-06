import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeMouseHandler } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

interface DashboardCanvasNodeData extends Record<string, unknown> {
  role: string;
  status: string;
  goal: string;
  taskId: string;
  doneWhenCount: number;
  sessionCount: number;
  evidenceCount: number;
  todoCount: number;
  changedFileCount: number;
  diffCount: number;
  latestSession?: {
    status: string;
    attemptId: string;
    sessionName: string | null;
    codexSessionId: string | null;
    latestText: string;
  } | null;
}

interface DashboardCanvasGraph {
  nodes: Array<Node<DashboardCanvasNodeData>>;
  edges: Edge[];
}

export interface DashboardCanvasRenderOptions {
  graph: DashboardCanvasGraph;
  selectedTaskId?: string | null;
  onSelectTask?: (taskId: string | null) => void;
}

declare global {
  interface Window {
    OuroborosCanvas?: {
      render: (mount: HTMLElement, options: DashboardCanvasRenderOptions | DashboardCanvasGraph) => void;
    };
  }
}

const roots = new WeakMap<HTMLElement, Root>();
const optionsStore = new WeakMap<HTMLElement, DashboardCanvasRenderOptions>();

function isDashboardGraph(value: DashboardCanvasRenderOptions | DashboardCanvasGraph): value is DashboardCanvasGraph {
  return Boolean(value && Array.isArray((value as DashboardCanvasGraph).nodes));
}

function selectTask(mount: HTMLElement, taskId: string | null) {
  const options = optionsStore.get(mount);
  if (!options || typeof options.onSelectTask !== "function") return;
  options.onSelectTask(taskId);
}

function handleSelectKey(event: React.KeyboardEvent<HTMLDivElement>, mount: HTMLElement, taskId: string) {
  if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
  event.preventDefault();
  selectTask(mount, taskId);
}

function CanvasNode({
  data,
  id,
  selected,
  mount,
}: {
  data: DashboardCanvasNodeData;
  id: string;
  selected: boolean;
  mount: HTMLElement;
}) {
  const latest = data.latestSession;
  const latestLabel = latest
    ? [latest.status, latest.sessionName || latest.codexSessionId || latest.attemptId].filter(Boolean).join(" · ")
    : "No session";
  const sessionLabel = data.sessionCount === 1 ? "1 session" : `${data.sessionCount} sessions`;
  const evidenceLabel = data.evidenceCount === 1 ? "1 evidence" : `${data.evidenceCount} evidence`;
  const todoRemaining = data.todoCount;
  const todoLabel = todoRemaining === 1 ? "1 todo" : `${todoRemaining} todos`;
  const nodeClass = [
    "of-node",
    `of-node-${data.status}`,
    selected ? "is-selected" : "",
  ].filter(Boolean).join(" ");
  return (
    <div
      className={nodeClass}
      data-task-id={id}
      data-selected-task={selected ? "true" : "false"}
      data-status={data.status}
      data-role={data.role}
      tabIndex={0}
      role="button"
      aria-pressed={selected ? "true" : "false"}
      aria-label={`Task ${data.role} ${data.status}: ${data.goal}. ${selected ? "Selected." : "Press Enter or Space to select."}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        selectTask(mount, id);
      }}
      onKeyDown={(event) => handleSelectKey(event, mount, id)}
    >
      <Handle className="of-handle" type="target" position={Position.Left} />
      <div className="of-node-head">
        <span className="of-node-role">{data.role}</span>
        <span className="of-node-status">{data.status}</span>
      </div>
      <div className="of-node-selected-marker" aria-hidden="true">
        {selected ? "Selected" : ""}
      </div>
      <div className="of-node-goal">{data.goal}</div>
      <div className="of-node-meta">
        <span className="of-node-meta-summary">{sessionLabel} · {evidenceLabel} · {todoLabel}</span>
        <span className="of-node-meta-latest">{latestLabel}</span>
      </div>
      <span className="of-node-task-id-sr" aria-hidden="true">{id}</span>
      <Handle className="of-handle" type="source" position={Position.Right} />
    </div>
  );
}

function Canvas({
  graph,
  selectedTaskId,
  mount,
}: {
  graph: DashboardCanvasGraph;
  selectedTaskId: string | null;
  mount: HTMLElement;
}) {
  const decoratedNodes = graph.nodes.map((node) => ({
    ...node,
    selected: Boolean(selectedTaskId && node.id === selectedTaskId),
  }));

  const handleNodeClick: NodeMouseHandler = (_event, node) => {
    selectTask(mount, node.id);
  };

  return (
    <div
      className="canvas-shell"
      data-canvas-selected-task-id={selectedTaskId ?? ""}
      data-canvas-task-count={graph.nodes.length}
      data-canvas-edge-count={graph.edges.length}
    >
      <ReactFlow
        nodes={decoratedNodes}
        edges={graph.edges}
        nodeTypes={{ task: (props) => <CanvasNode {...props} data={props.data as DashboardCanvasNodeData} mount={mount} /> }}
        onNodeClick={handleNodeClick}
        nodesFocusable
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        selectNodesOnDrag={false}
        fitView
        minZoom={0.35}
        maxZoom={1.4}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#27272a" gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => {
            const status = String(node.data?.status || "");
            if (status === "running") return "#a1a1aa";
            if (status === "blocked") return "#52525b";
            if (status === "done") return "#71717a";
            return "#3f3f46";
          }}
          nodeStrokeColor="#27272a"
          nodeBorderRadius={4}
          maskColor="rgba(10, 10, 10, 0.65)"
          style={{ background: "#0a0a0a" }}
        />
      </ReactFlow>
    </div>
  );
}

function render(mount: HTMLElement, options: DashboardCanvasRenderOptions | DashboardCanvasGraph) {
  const normalized: DashboardCanvasRenderOptions = isDashboardGraph(options)
    ? { graph: options, selectedTaskId: null, onSelectTask: undefined }
    : options;
  optionsStore.set(mount, normalized);
  let root = roots.get(mount);
  if (!root) {
    root = createRoot(mount);
    roots.set(mount, root);
  }
  root.render(
    <StrictMode>
      <Canvas
        graph={normalized.graph}
        selectedTaskId={normalized.selectedTaskId ?? null}
        mount={mount}
      />
    </StrictMode>,
  );
}

window.OuroborosCanvas = { render };

window.dispatchEvent(new CustomEvent("ouroboros-canvas-ready"));
