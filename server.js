const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const authenticateUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token.' });
  }

  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: 'Unauthorized session.' });
  }

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

    stores = storeLinks ? storeLinks.map(s => s.stores) : [];
  }

  req.user = user;
  req.userRole = role;
  req.userStores = stores;
  next();
};

app.post('/api/user/assign-first-store', authenticateUser, async (req, res) => {
  const { storeId } = req.body;
  const userId = req.user.id;

  if (!storeId) {
    return res.status(400).json({ error: 'Store ID is required.' });
  }

  try {
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

    const { error: insertError } = await supabase
      .from('user_stores')
      .insert([{ user_id: userId, store_id: storeId }]);

    if (insertError) throw insertError;

    res.json({ success: true, message: 'Primary store assigned successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get saved feature menu selections only (NO prices here)
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

// Save feature menu selections only (NO prices here)
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

// Menu Price update (Handles all item prices, including 6oz and 9oz medallion base UUIDs)
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

app.get('/api/auth/me', authenticateUser, (req, res) => {
  res.json({
    user: req.user,
    role: req.userRole,
    stores: req.userStores
  });
});

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

app.post('/api/admin/users', authenticateUser, async (req, res) => {
  if (req.userRole !== 'admin' && req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Admin permissions required.' });
  }

  const { email, password, role, storeIds } = req.body;

  if (role === 'superadmin' && req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Only Superadmins can assign Superadmin role.' });
  }

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });

  if (authError) return res.status(400).json({ error: authError.message });

  await supabase
    .from('user_profiles')
    .insert([{ id: authData.user.id, email: email.toLowerCase(), role: role || 'user' }]);

  if (storeIds && storeIds.length > 0) {
    const storeRows = storeIds.map(storeId => ({
      user_id: authData.user.id,
      store_id: storeId
    }));
    await supabase.from('user_stores').insert(storeRows);
  }

  res.json({ message: 'User created successfully', userId: authData.user.id });
});

app.post('/api/admin/reset-password', authenticateUser, async (req, res) => {
  if (req.userRole !== 'admin' && req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Admin permissions required.' });
  }

  const { userId, newPassword } = req.body;

  if (!userId || !newPassword) {
    return res.status(400).json({ error: 'User ID and new password are required.' });
  }

  const { error } = await supabase.auth.admin.updateUserById(userId, {
    password: newPassword
  });

  if (error) return res.status(400).json({ error: error.message });

  res.json({ message: 'Password updated successfully.' });
});

app.get('/api/admin/users', authenticateUser, async (req, res) => {
  if (req.userRole !== 'admin' && req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Admin permissions required.' });
  }

  const { data: profiles, error } = await supabase
    .from('user_profiles')
    .select('id, email, role, created_at, user_stores(store_id, stores(name))');

  if (error) return res.status(500).json({ error: error.message });

  res.json({ users: profiles || [] });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend server running on port ${PORT}`));