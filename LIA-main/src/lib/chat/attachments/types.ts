import 'server-only';

/** Public metadata stored on Message.attachmentsJson and returned to the client. */
export type ChatAttachmentMeta = {
  id: string;
  name: string;
  mimeType: string;
  kind: ChatAttachmentKind;
  sizeBytes: number;
};

export type ChatAttachmentKind = 'image' | 'text' | 'pdf' | 'docx';

export type ResolvedChatAttachment = ChatAttachmentMeta & {
  storageKey: string;
  textPreview: string | null;
  /** Absolute path on disk (server-only). */
  absolutePath: string;
};
