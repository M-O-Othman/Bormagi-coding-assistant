export interface Meeting {
  id: string;
  title: string;
  status: 'setup' | 'active' | 'completed';
  created_at: string;
  participants: string[];          // agent IDs
  resourceFiles: string[];         // relative workspace file paths
  agenda: AgendaItem[];
  rounds: MeetingRound[];
  actionItems: ActionItem[];
}

export interface AgendaItem {
  id: string;
  text: string;
  status: 'pending' | 'discussing' | 'resolved';
  decision?: string;
}

export interface MeetingRound {
  agendaItemId: string;
  agentId: string;
  response: string;
  timestamp: string;
}

export interface ActionItem {
  id: string;
  text: string;
  assignedTo: string;              // agent ID
}
