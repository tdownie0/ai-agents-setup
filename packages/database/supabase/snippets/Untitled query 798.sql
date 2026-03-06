CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.users (id, full_name, email)
  VALUES (
    new.id, 
    -- If full_name is missing from metadata, use 'New User' as a placeholder
    COALESCE(new.raw_user_meta_data->>'full_name', 'New User'), 
    new.email
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;