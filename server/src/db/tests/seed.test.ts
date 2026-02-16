import { describe, it, expect } from 'vitest';
import { db } from '../index';
import { users } from '../schema';
import { count } from 'drizzle-orm';

describe('Database Seeding', () => {
  it('should have 50 users in the database', async () => {
    const result = await db.select({ count: count() }).from(users);
    const userCount = result[0]?.count ?? 0;
    
    expect(userCount).toBe(50);
  });
});
