export type UserProfileDto = {
  id: string; email: string; firstName: string; lastName: string;
  globalRole: 'USER' | 'ADMIN'; emailReminders: boolean; emailAnnouncements: boolean;
};
export type LoginUser = { id: string; email: string; passwordHash: string | null; globalRole: 'USER' | 'ADMIN'; status: 'ACTIVE' | 'SUSPENDED' | 'DELETED' };
export type NewStudent = { id: string; email: string; firstName: string; lastName: string; passwordHash: string };
export type NewAdminInput = { email: string; firstName: string; lastName: string; password: string };
