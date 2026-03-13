import { supabase } from "./supabase";
import type { Notification } from "@model_md/database";

const API_BASE = "/api";

const getAuthHeaders = async () => {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session?.access_token}`,
  };
};

export const notificationApi = {
  create: async (notification: {
    type: string;
    title: string;
    message: string;
  }): Promise<Notification> => {
    const headers = await getAuthHeaders();
    const response = await fetch(`${API_BASE}/notifications`, {
      method: "POST",
      headers,
      body: JSON.stringify(notification),
    });
    if (!response.ok) throw new Error("Failed to create notification");
    return response.json();
  },

  list: async (): Promise<Notification[]> => {
    const headers = await getAuthHeaders();
    const response = await fetch(`${API_BASE}/notifications`, {
      headers,
    });
    if (!response.ok) throw new Error("Failed to fetch notifications");
    return response.json();
  },

  markAsRead: async (id: number): Promise<{ success: boolean }> => {
    const headers = await getAuthHeaders();
    const response = await fetch(`${API_BASE}/notifications/${id}/read`, {
      method: "PATCH",
      headers,
    });
    if (!response.ok) throw new Error("Failed to mark as read");
    return response.json();
  },

  delete: async (id: number): Promise<{ success: boolean }> => {
    const headers = await getAuthHeaders();
    const response = await fetch(`${API_BASE}/notifications/${id}`, {
      method: "DELETE",
      headers,
    });
    if (!response.ok) throw new Error("Failed to delete");
    return response.json();
  },
};
