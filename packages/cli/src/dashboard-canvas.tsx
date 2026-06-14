import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

interface DashboardCanvasNodeData extends Record<string, unknown> {
  role: string;
  status: string;
  goal: string;
  taskId: string;
  doneWhenCount: number;
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

declare global {
  interface Window {
    OuroborosCanvas?: {
      render: (mount: HTMLElement, graph: DashboardCanvasGraph) => void;
    };
  }
}

const roots = new WeakMap<HTMLElement, Root>();

function CanvasNode({ data }: { data: DashboardCanvasNodeData }) {
  const latest = data.latestSession;
  return (
    <div className={`of-node of-node-${data.status}`}>
      <Handle className="of-handle" type="target" position={Position.Left} />
      <div className="of-node-head">
        <span>{data.role}</span>
        <span>{data.status}</span>
      </div>
      <div className="of-node-goal">{data.goal}</div>
      <div className="of-node-meta">
        <span>id {data.taskId}</span>
        <span>doneWhen {data.doneWhenCount}</span>
        <span>
          {latest
            ? `${latest.status} ${latest.sessionName || latest.codexSessionId || latest.attemptId}`
            : "no session"}
        </span>
      </div>
      <Handle className="of-handle" type="source" position={Position.Right} />
    </div>
  );
}

function Canvas({ graph }: { graph: DashboardCanvasGraph }) {
  return (
    <ReactFlow
      nodes={graph.nodes}
      edges={graph.edges}
      nodeTypes={{ task: CanvasNode }}
      fitView
      minZoom={0.35}
      maxZoom={1.4}
    >
      <Background color="#d7d7d7" gap={18} size={1} />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        nodeColor={(node) => {
          const status = String(node.data?.status || "");
          if (status === "running") return "#d8d8d8";
          if (status === "blocked") return "#9f9f9f";
          if (status === "done") return "#f0f0f0";
          return "#c5c5c5";
        }}
      />
    </ReactFlow>
  );
}

function render(mount: HTMLElement, graph: DashboardCanvasGraph) {
  let root = roots.get(mount);
  if (!root) {
    root = createRoot(mount);
    roots.set(mount, root);
  }
  root.render(
    <StrictMode>
      <Canvas graph={graph} />
    </StrictMode>,
  );
}

window.OuroborosCanvas = { render };

window.dispatchEvent(new CustomEvent("ouroboros-canvas-ready"));
