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

export type UserTier = 'free' | 'pro' | 'enterprise';

export interface MeetingMinutes {
  summary: string;
  actionItems: string[];
  keyDecisions: string[];
}

export interface Poll {
  id: string;
  question: string;
  options: string[];
  votes: Record<string, number>; // userId -> optionIndex
  active: boolean;
  createdAt: string;
}
