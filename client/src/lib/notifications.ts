import type { Notification } from '../types/notification';

const API_BASE = 'http://localhost:3000/api';

export const notificationApi = {
  create: async (notification: {
    userId: number;
    type: string;
    title: string;
    message: string;
  }): Promise<Notification> => {
    const response = await fetch(`${API_BASE}/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notification),
    });
    if (!response.ok) {
      throw new Error('Failed to create notification');
    }
    return response.json();
  },

  list: async (userId: number): Promise<Notification[]> => {
    const response = await fetch(`${API_BASE}/notifications?userId=${userId}`);
    if (!response.ok) {
      throw new Error('Failed to fetch notifications');
    }
    return response.json();
  },

  markAsRead: async (id: number): Promise<{ success: boolean }> => {
    const response = await fetch(`${API_BASE}/notifications/${id}/read`, {
      method: 'PATCH',
    });
    if (!response.ok) {
      throw new Error('Failed to mark notification as read');
    }
    return response.json();
  },

  delete: async (id: number): Promise<{ success: boolean }> => {
    const response = await fetch(`${API_BASE}/notifications/${id}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error('Failed to delete notification');
    }
    return response.json();
  },
};
