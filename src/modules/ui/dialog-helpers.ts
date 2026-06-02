export function requiredElement<T extends Element>(
  doc: Document,
  id: string,
): T {
  const element = doc.getElementById(id);
  if (!element) {
    throw new Error(`Missing required dialog element: ${id}`);
  }
  return element as unknown as T;
}
