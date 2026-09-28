const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

// Enable CORS for all routes and HTTP methods
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ==========================================
// AUTHENTICATION MIDDLEWARE
// ==========================================
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization token.' });
    }

    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Unauthorized session.' });
    }

    // Safely retrieve user profile without throwing PGRST116 single-row errors
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role, first_name, last_name, primary_store_id')
      .eq('id', user.id)
      .maybeSingle();

    const role = profile?.role || 'user';
    let stores = [];

    if (role === 'superadmin') {
      const { data: allStores } = await supabase.from('stores').select('*');
      stores = allStores || [];
    } else {
      const { data: storeLinks } = await supabase
        .from('user_stores')
        .select('store_id, stores(id, name, has_holiday_feature, nickname, location, state, division)')
        .eq('user_id', user.id);

      stores = storeLinks ? storeLinks.map(s => s.stores).filter(Boolean) : [];
    }

    req.user = user;
    req.userRole = role;
    req.userStores = stores;
    req.userProfile = {
      first_name: profile?.first_name || '',
      last_name: profile?.last_name || '',
      primary_store_id: profile?.primary_store_id || null
    };

    next();
  } catch (err) {
    console.error('Auth Middleware Error:', err);
    return res.status(500).json({ error: 'Authentication processing failed.' });
  }
};

// ==========================================
// STORES CRUD ROUTES
// ==========================================
app.get('/api/stores', authenticateUser, async (req, res) => {
  try {
    const { data: stores, error } = await supabase
      .from('stores')
      .select('*')
      .order('name');

    if (error) throw error;
    res.json({ stores: stores || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stores', authenticateUser, async (req, res) => {
  if (req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin permissions required.' });
  }

  const { name, nickname, location, state, division, has_holiday_feature } = req.body;

  try {
    const { data, error } = await supabase
      .from('stores')
      .insert([{ name, nickname, location, state, division, has_holiday_feature: !!has_holiday_feature }])
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, store: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/stores/:id', authenticateUser, async (req, res) => {
  if (req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin permissions required.' });
  }

  const { id } = req.params;
  const updates = req.body;

  try {
    const { data, error } = await supabase
      .from('stores')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, store: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/stores/:id', authenticateUser, async (req, res) => {
  if (req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin permissions required.' });
  }

  const { id } = req.params;

  try {
    const { error } = await supabase.from('stores').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true, message: 'Store deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// GENERAL AUTH & USER CONFIG ROUTES
// ==========================================
app.get('/api/auth/me', authenticateUser, (req, res) => {
  res.json({
    user: req.user,
    role: req.userRole,
    stores: req.userStores,
    profile: req.userProfile
  });
});

app.post('/api/user/assign-first-store', authenticateUser, async (req, res) => {
  const { storeId } = req.body;
  const userId = req.user.id;

  if (!storeId) {
    return res.status(400).json({ error: 'Store ID is required.' });
  }

  try {
    // 1. Guard against users who already have store assignments
    const { data: existingStores, error: checkError } = await supabase
      .from('user_stores')
      .select('store_id')
      .eq('user_id', userId);

    if (checkError) throw checkError;

    if (existingStores && existingStores.length > 0) {
      return res.status(403).json({ 
        error: 'Store already selected. Contact a Superadmin to change your store assignment.' 
      });
    }

    // 2. Insert store junction record into user_stores
    const { error: insertError } = await supabase
      .from('user_stores')
      .insert([{ user_id: userId, store_id: storeId }]);

    if (insertError) throw insertError;

    // 3. Update or create primary_store_id in user_profiles
    const { error: profileError } = await supabase
      .from('user_profiles')
      .upsert(
        { id: userId, primary_store_id: storeId },
        { onConflict: 'id' }
      );

    if (profileError) throw profileError;

    return res.json({ success: true, message: 'Primary store assigned successfully.' });
  } catch (err) {
    console.error('Error assigning primary store:', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error.' });
  }
});

// ==========================================
// MENU MANAGEMENT ROUTES & HANDLERS
// ==========================================

// GET all menu items
const getMenuItemsHandler = async (req, res) => {
  try {
    const { data: items, error } = await supabase
      .from('menu_items')
      .select('*')
      .order('short_name');

    if (error) throw error;
    res.json({ items: items || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

app.get('/api/menu/items', authenticateUser, getMenuItemsHandler);
app.get('/api/admin/menu-items', authenticateUser, getMenuItemsHandler);

// POST create new menu item
const createMenuItemHandler = async (req, res) => {
  if (req.userRole !== 'admin' && req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Admin permissions required.' });
  }

  const itemData = req.body;

  try {
    const { data, error } = await supabase
      .from('menu_items')
      .insert([itemData])
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, item: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

app.post('/api/menu/items', authenticateUser, createMenuItemHandler);
app.post('/api/admin/menu-items', authenticateUser, createMenuItemHandler);

// PUT / PATCH update existing menu item
const updateMenuItemHandler = async (req, res) => {
  if (req.userRole !== 'admin' && req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Admin permissions required.' });
  }

  const { id } = req.params;
  const updates = req.body;

  try {
    const { data, error } = await supabase
      .from('menu_items')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, item: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

app.patch('/api/menu/items/:id', authenticateUser, updateMenuItemHandler);
app.put('/api/menu/items/:id', authenticateUser, updateMenuItemHandler);
app.patch('/api/admin/menu-items/:id', authenticateUser, updateMenuItemHandler);
app.put('/api/admin/menu-items/:id', authenticateUser, updateMenuItemHandler);

// DELETE menu item
const deleteMenuItemHandler = async (req, res) => {
  if (req.userRole !== 'admin' && req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Admin permissions required.' });
  }

  const { id } = req.params;

  try {
    const { error } = await supabase.from('menu_items').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true, message: 'Menu item deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

app.delete('/api/menu/items/:id', authenticateUser, deleteMenuItemHandler);
app.delete('/api/admin/menu-items/:id', authenticateUser, deleteMenuItemHandler);

// Menu & Pricing configuration routes
app.get('/api/menu', authenticateUser, async (req, res) => {
  const { storeId } = req.query;

  if (!storeId) {
    return res.status(400).json({ error: 'Store ID is required.' });
  }

  try {
    const { data: items, error: itemsErr } = await supabase
      .from('menu_items')
      .select('*')
      .order('section');

    if (itemsErr) throw itemsErr;

    const { data: pricesData, error: pricesErr } = await supabase
      .from('store_prices')
      .select('item_id, price')
      .eq('store_id', storeId);

    if (pricesErr) throw pricesErr;

    const { data: activeData, error: activeErr } = await supabase
      .from('active_selections')
      .select('item_id')
      .eq('store_id', storeId);

    if (activeErr) throw activeErr;

    const prices = {};
    (pricesData || []).forEach(p => {
      prices[p.item_id] = parseFloat(p.price);
    });

    const activeSelections = (activeData || []).map(a => a.item_id);

    res.json({
      items: items || [],
      prices,
      activeSelections
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/store-menu/:storeId', authenticateUser, async (req, res) => {
  const { storeId } = req.params;

  try {
    const { data, error } = await supabase
      .from('store_feature_menus')
      .select('selected_item_ids')
      .eq('store_id', storeId)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    res.json(data || { selected_item_ids: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/store-menu/:storeId', authenticateUser, async (req, res) => {
  const { storeId } = req.params;
  const { selectedItemIds } = req.body;

  try {
    const { error } = await supabase
      .from('store_feature_menus')
      .upsert({
        store_id: storeId,
        selected_item_ids: selectedItemIds,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'store_id' });

    if (error) throw error;

    res.json({ success: true, message: 'Store menu saved successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/menu/price', authenticateUser, async (req, res) => {
  const { storeId, itemId, price } = req.body;

  if (!storeId || !itemId || price === undefined) {
    return res.status(400).json({ error: 'Missing storeId, itemId, or price.' });
  }

  try {
    const { error } = await supabase
      .from('store_prices')
      .upsert(
        {
          store_id: storeId,
          item_id: itemId,
          price: parseFloat(price) || 0,
        },
        { onConflict: 'store_id,item_id' }
      );

    if (error) throw error;

    res.json({ success: true, message: 'Price updated successfully.' });
  } catch (err) {
    console.error('Error saving item price:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// USER & ADMIN MANAGEMENT CRUD ROUTES
// ==========================================
app.get('/api/admin/users', authenticateUser, async (req, res) => {
  if (req.userRole !== 'admin' && req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Admin permissions required.' });
  }

  try {
    const { data: profiles, error } = await supabase
      .from('user_profiles')
      .select('id, first_name, last_name, email, role, primary_store_id, created_at, user_stores(store_id, stores(id, name))');

    if (error) throw error;

    const formattedUsers = (profiles || []).map(u => ({
      ...u,
      store_ids: u.user_stores ? u.user_stores.map(us => us.store_id) : []
    }));

    res.json({ users: formattedUsers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users', authenticateUser, async (req, res) => {
  if (req.userRole !== 'admin' && req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Admin permissions required.' });
  }

  const { email, password, first_name, last_name, role, primary_store_id, store_ids } = req.body;

  if (role === 'superadmin' && req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Only Superadmins can assign Superadmin role.' });
  }

  try {
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });

    if (authError) return res.status(400).json({ error: authError.message });

    const userId = authData.user.id;

    await supabase
      .from('user_profiles')
      .insert([{ 
        id: userId, 
        email: email.toLowerCase(), 
        first_name: first_name || '',
        last_name: last_name || '',
        role: role || 'user',
        primary_store_id: primary_store_id || null
      }]);

    if (store_ids && store_ids.length > 0) {
      const storeRows = store_ids.map(storeId => ({
        user_id: userId,
        store_id: storeId
      }));
      await supabase.from('user_stores').insert(storeRows);
    }

    res.json({ success: true, message: 'User created successfully', userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/users/:id', authenticateUser, async (req, res) => {
  if (req.userRole !== 'admin' && req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Admin permissions required.' });
  }

  const { id } = req.params;
  const { first_name, last_name, role, primary_store_id, store_ids, password } = req.body;

  try {
    if (password) {
      const { error: passError } = await supabase.auth.admin.updateUserById(id, { password });
      if (passError) return res.status(400).json({ error: passError.message });
    }

    const profileUpdates = {};
    if (first_name !== undefined) profileUpdates.first_name = first_name;
    if (last_name !== undefined) profileUpdates.last_name = last_name;
    
    // Restricted to superadmin actions
    if (req.userRole === 'superadmin') {
      if (role !== undefined) profileUpdates.role = role;
      if (primary_store_id !== undefined) profileUpdates.primary_store_id = primary_store_id || null;
    }

    if (Object.keys(profileUpdates).length > 0) {
      const { error: profileError } = await supabase
        .from('user_profiles')
        .update(profileUpdates)
        .eq('id', id);

      if (profileError) throw profileError;
    }

    if (store_ids !== undefined && req.userRole === 'superadmin') {
      await supabase.from('user_stores').delete().eq('user_id', id);

      if (store_ids.length > 0) {
        const storeRows = store_ids.map(storeId => ({
          user_id: id,
          store_id: storeId
        }));
        await supabase.from('user_stores').insert(storeRows);
      }
    }

    res.json({ success: true, message: 'User updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:id', authenticateUser, async (req, res) => {
  if (req.userRole !== 'admin' && req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Admin permissions required.' });
  }

  const { id } = req.params;

  try {
    const { error } = await supabase.auth.admin.deleteUser(id);
    if (error) throw error;

    res.json({ success: true, message: 'User deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fallback JSON 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.originalUrl}` });
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend server running on port ${PORT}`));