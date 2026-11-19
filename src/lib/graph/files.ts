import { parsePdf } from "@/knowledge/pdf";
import { type FetchFn, graphJson, graphRequest } from "@/lib/graph/client";
import { capText, graphSearch, type M365Item, plainSummary } from "@/lib/graph/m365-item";
import { SafeError } from "@/lib/safe-error";

interface DriveItem {
  id?: string;
  name?: string;
  webUrl?: string;
  lastModifiedDateTime?: string;
  parentReference?: { driveId?: string; path?: string };
}

const TEXT_TYPES = new Set(["md", "txt", "csv"]);
/** Office files Graph can convert to PDF, which the handbook's PDF parser then reads. */
const CONVERTIBLE_TYPES = new Set(["docx", "doc", "pptx", "ppt", "xlsx", "xls", "rtf", "odt"]);

export const UNREADABLE_FILE = "This file type can't be read.";
const NO_TEXT = "This file has no readable text (it may be a scan).";

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** ["Files", ...folders] from a parent path such as "/drive/root:/Clients/Acme". */
function fileLocation(parentPath: string | undefined): string[] {
  const folders = (parentPath?.split(":")[1] ?? "").split("/").filter(Boolean);
  return ["Files", ...folders.map(decodeURIComponent)];
}

function toItem(resource: DriveItem, ref: string, text: string): M365Item {
  return {
    kind: "file",
    ref,
    title: resource.name ?? "Untitled file",
    location: fileLocation(resource.parentReference?.path),
    url: resource.webUrl ?? "",
    lastModified: resource.lastModifiedDateTime ?? "",
    text,
  };
}

/** Files the user can open in OneDrive and SharePoint that match the query, with snippets. */
export async function searchFiles(
  query: string,
  token: string,
  fetchFn?: FetchFn,
): Promise<M365Item[]> {
  const hits = await graphSearch<DriveItem>({ entityType: "driveItem", query, token, fetchFn });
  const items: M365Item[] = [];
  for (const hit of hits) {
    const resource = hit.resource;
    const id = resource?.id ?? hit.hitId;
    const driveId = resource?.parentReference?.driveId;
    if (!resource || !id || !driveId) continue;
    items.push(toItem(resource, `${driveId}/${id}`, plainSummary(hit.summary)));
  }
  return items;
}

function parseRef(ref: string): { driveId: string; itemId: string } {
  const [driveId, itemId, ...rest] = ref.split("/");
  if (!driveId || !itemId || rest.length > 0) {
    throw new SafeError("Unknown file reference; use a ref from search_files");
  }
  return { driveId, itemId };
}

/**
 * The PDF's title and sections as text. A PDF the parser can't read (a scan without a text
 * layer, or a damaged file) gives a short note, so one bad file doesn't end the answer.
 */
async function pdfText(response: Response): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  let document: Awaited<ReturnType<typeof parsePdf>>;
  try {
    document = await parsePdf(bytes);
  } catch {
    return NO_TEXT;
  }
  const sections = document.sections.map((section) => {
    const heading = section.headingPath.length ? `## ${section.headingPath.join(" > ")}\n` : "";
    return heading + section.text;
  });
  return [document.title ? `# ${document.title}` : "", ...sections].filter(Boolean).join("\n\n");
}

/** A file's full text: PDFs and text files as they are, Office files converted to PDF. */
export async function readFile(ref: string, token: string, fetchFn?: FetchFn): Promise<M365Item> {
  const { driveId, itemId } = parseRef(ref);
  const path = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
  const options = { token, ...(fetchFn ? { fetchFn } : {}) };
  const select = "name,webUrl,lastModifiedDateTime,file,parentReference";
  const resource = await graphJson<DriveItem>(`${path}?$select=${select}`, options);
  const type = extension(resource.name ?? "");

  let text: string;
  if (TEXT_TYPES.has(type)) {
    text = await (await graphRequest(`${path}/content`, options)).text();
  } else if (type === "pdf") {
    text = await pdfText(await graphRequest(`${path}/content`, options));
  } else if (CONVERTIBLE_TYPES.has(type)) {
    text = await pdfText(await graphRequest(`${path}/content?format=pdf`, options));
  } else {
    return toItem(resource, ref, UNREADABLE_FILE);
  }
  return toItem(resource, ref, capText(text));
}
