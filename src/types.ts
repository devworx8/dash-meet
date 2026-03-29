export interface Message {
  sender: string;
  text: string;
  timestamp: string;
}

export interface Participant {
  id: string;
  stream?: MediaStream;
  name?: string;
}

export interface MeetingMinutes {
  summary: string;
  actionItems: string[];
  keyDecisions: string[];
}
