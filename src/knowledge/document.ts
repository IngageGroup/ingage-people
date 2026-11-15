/** A source document after parsing, before chunking. Every parser produces this. */
export interface ParsedDocument {
  title: string;
  sections: DocumentSection[];
}

export interface DocumentSection {
  /** Headings above the text, outermost first. Empty for text before the first heading. */
  headingPath: string[];
  text: string;
  page?: number;
}
