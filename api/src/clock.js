// Single source of "now" so tests can pin the time. All business logic
// passes this value to SQL instead of relying on the database's now().
let fixed = null;

module.exports = {
  now: () => (fixed ? new Date(fixed) : new Date()),
  set: (date) => { fixed = date ? new Date(date) : null; },
};
