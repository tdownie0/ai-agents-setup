/**
 * User type definition matching the Drizzle ORM schema
 * Represents a user entity from the database
 */
export interface User {
  /** Unique identifier for the user */
  id: number;
  
  /** User's full name */
  fullName: string;
  
  /** User's email address (unique) */
  email: string;
  
  /** Timestamp when the user was created (ISO string format) */
  createdAt: string;
}

/**
 * Type for creating a new user (omits auto-generated fields)
 */
export type CreateUserInput = Omit<User, 'id' | 'createdAt'>;

/**
 * Type for updating an existing user (all fields optional except id)
 */
export type UpdateUserInput = Partial<Omit<User, 'id'>> & { id: number };
