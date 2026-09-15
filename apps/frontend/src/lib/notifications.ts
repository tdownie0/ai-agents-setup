import type { ApiNotification } from "./api";
import { client, getAuthHeaders } from "./api";

export const notificationApi = {
  create: async (notification: { type: string; title: string; message: string }) => {
    const res = await client.api.notifications.$post(
      { json: notification },
      { headers: await getAuthHeaders() },
    );
    if (!res.ok) throw new Error("Failed to create notification");
    return res.json();
  },

  list: async (): Promise<ApiNotification[]> => {
    const res = await client.api.notifications.$get({}, { headers: await getAuthHeaders() });
    if (!res.ok) throw new Error("Failed to fetch notifications");
    return res.json();
  },

  markAsRead: async (id: number) => {
    const res = await client.api.notifications[":id"].read.$patch(
      { param: { id: String(id) } },
      { headers: await getAuthHeaders() },
    );
    if (!res.ok) throw new Error("Failed to mark as read");
    return res.json();
  },

  delete: async (id: number) => {
    const res = await client.api.notifications[":id"].$delete(
      { param: { id: String(id) } },
      { headers: await getAuthHeaders() },
    );
    if (!res.ok) throw new Error("Failed to delete");
    return res.json();
  },
};
