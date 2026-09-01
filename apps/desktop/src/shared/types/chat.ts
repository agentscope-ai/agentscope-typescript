export interface Session {
    id: string;
    agentKey: string;
    name: string;
    pinned: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface GetSessionsQuery {
    offset: number;
    limit: number;
}

export interface GetSessionsResult {
    pinned: Session[];
    items: Session[];
    total: number;
    hasMore: boolean;
}
