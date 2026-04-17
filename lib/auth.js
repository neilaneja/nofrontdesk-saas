// Authentication middleware

function requireLogin(req, res, next) {
  if (req.session && req.session.accountId) {
    return next();
  }
  res.redirect('/login');
}

function requireGuest(req, res, next) {
  if (req.session && req.session.accountId) {
    return res.redirect('/dashboard');
  }
  next();
}

module.exports = { requireLogin, requireGuest };
