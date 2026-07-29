export type MessageSummary = {
  id: string;
  threadId: string;
  subject: string | null;
  from: string | null;
  to: string | null;
  date: string | null; // ISO
  snippet: string | null;
  labelIds: string[];
  isUnread: boolean;
};

export type MessageDetail = {
  id: string;
  threadId: string;
  subject: string | null;
  from: string | null;
  to: string | null;
  date: string | null;
  snippet: string | null;
  labelIds: string[];
  isUnread: boolean;
  // Not returning full body to avoid exposing sensitive content
  // Provide limited preview only
  preview?: string | null;
};

export type ThreadDetail = {
  id: string;
  messages: MessageDetail[];
};

export type ListMessagesResult = {
  messages: MessageSummary[];
  nextPageToken?: string | null;
};
