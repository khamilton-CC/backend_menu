import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // Use Service Role Key for backend admin queries
);

export interface AuthenticatedRequest extends Request {
  user?: any;
  userRole?: string;
  userStores?: any[];
}

export async function verifySupabaseToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization token.' });
  }

  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: 'Unauthorized session.' });
  }

  // Fetch user profile and assigned stores
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  const role = profile?.role || 'user';
  let stores = [];

  if (role === 'superadmin') {
    const { data: allStores } = await supabase.from('stores').select('*');
    stores = allStores || [];
  } else {
    const { data: storeLinks } = await supabase
      .from('user_stores')
      .select('store_id, stores(id, name, has_holiday_feature)')
      .eq('user_id', user.id);

    stores = storeLinks ? storeLinks.map((s: any) => s.stores) : [];
  }

  req.user = user;
  req.userRole = role;
  req.userStores = stores;

  next();
}