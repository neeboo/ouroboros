type StaticElement = {
  type: string | ((props: Record<string, unknown>) => StaticNode);
  props: Record<string, unknown> | null;
};

type StaticNode = StaticElement | StaticNode[] | string | number | boolean | null | undefined;

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

export function renderStaticNode(node: StaticNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return escapeAttribute(node);
  if (Array.isArray(node)) return node.map((child) => renderStaticNode(child)).join("");
  if (!isStaticElement(node)) return "";
  if (typeof node.type === "function") {
    return renderStaticNode(node.type(node.props ?? {}));
  }
  if (typeof node.type === "symbol") {
    return renderStaticNode((node.props ?? {}).children as StaticNode);
  }
  const props = node.props ?? {};
  const tagName = node.type;
  const children = props.children;
  const attributes = renderStaticAttributes(tagName, props);
  if (VOID_ELEMENTS.has(tagName)) return `<${tagName}${attributes}>`;
  const content = tagName === "textarea" && typeof props.defaultValue === "string"
    ? escapeAttribute(props.defaultValue)
    : renderStaticNode(children as StaticNode);
  return `<${tagName}${attributes}>${content}</${tagName}>`;
}

function isStaticElement(node: StaticNode): node is StaticElement {
  return !!node && typeof node === "object" && !Array.isArray(node) && "type" in node && "props" in node;
}

function renderStaticAttributes(tagName: string, props: Record<string, unknown>) {
  const attributes: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(props)) {
    if (rawKey === "children" || rawKey === "key" || rawKey === "defaultValue") continue;
    if (rawValue === null || rawValue === undefined) continue;
    if (rawValue === false && !rawKey.startsWith("aria-") && !rawKey.startsWith("data-")) continue;
    const key = attributeName(rawKey);
    if (rawValue === true) {
      attributes.push(key);
      continue;
    }
    if (tagName === "textarea" && rawKey === "value") continue;
    attributes.push(`${key}="${escapeAttribute(rawValue)}"`);
  }
  return attributes.length ? ` ${attributes.join(" ")}` : "";
}

function attributeName(key: string) {
  if (key === "className") return "class";
  if (key === "htmlFor") return "for";
  return key;
}

function escapeAttribute(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] || char));
}
