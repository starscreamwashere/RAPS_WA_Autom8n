-- Starting data. Values come from docs/OWNER_FACTS.md; the owner can change
-- settings later with the SET owner command, and the rest with SQL.

INSERT INTO units (code) VALUES
  ('PS5-01'), ('PS5-02'), ('PS5-03'), ('PS5-04'), ('PS5-05'), ('PS5-06');

INSERT INTO settings (key, value) VALUES
  ('birthday_bookings_enabled', 'false'),   -- birthdays not launched yet
  ('hold_minutes',              '120'),
  ('hold_nudge_before_min',     '30'),
  ('setup_buffer_min',          '45'),
  ('teardown_buffer_min',       '30'),
  ('travel_buffer_min',         '90'),
  ('birthday_default_hours',    '3'),
  ('business_open',             '"09:00"'),
  ('business_close',            '"20:00"'),
  ('controllers_total',         '20'),
  ('controllers_per_setup_max', '4'),
  ('advance_pct_rental',        '10'),
  ('advance_pct_birthday',      '50'),
  ('reminder_hours_before',     '24'),
  ('payment_upi_id',            '"vindyreddy3011@oksbi"'),
  ('payment_upi_name',          '"RAPS Powerplay"'),
  ('business_phone',            '"919082201911"');

INSERT INTO rates (code, label, amount, unit, includes) VALUES
  ('birthday_station', 'Birthday Gaming Station', 9000, 'per_setup',
   ARRAY['PlayStation 5 with 4 controllers', 'TV + stand', '3 hours of gaming',
         'Delivery, setup & teardown', 'On-site gaming support']),
  ('decoration', 'Birthday decoration', NULL, 'per_event', '{}');

-- Rental rate card (owner, 18 Oct 2026). Month is ₹9,000 whatever the controller count.
INSERT INTO rental_rates (package, days, controllers, amount) VALUES
  ('day',   1, 1,  950), ('day',   1, 2, 1200), ('day',   1, 3, 1400), ('day',   1, 4, 1600),
  ('week',  7, 1, 2750), ('week',  7, 2, 2999), ('week',  7, 3, 3399), ('week',  7, 4, 3799),
  ('month', 30, 1, 9000), ('month', 30, 2, 9000), ('month', 30, 3, 9000), ('month', 30, 4, 9000);

-- Service area: Mumbai, Navi Mumbai, Thane West, Vasai. Curated starting list;
-- anything not matched comes back as "unknown" and goes to the owner.
INSERT INTO service_areas (region, locality, aliases) VALUES
  ('Mumbai', 'Colaba', '{}'), ('Mumbai', 'Fort', '{}'), ('Mumbai', 'Churchgate', '{}'),
  ('Mumbai', 'Marine Lines', '{}'), ('Mumbai', 'Grant Road', '{}'), ('Mumbai', 'Malabar Hill', '{}'),
  ('Mumbai', 'Tardeo', '{}'), ('Mumbai', 'Byculla', '{}'), ('Mumbai', 'Worli', '{}'),
  ('Mumbai', 'Lower Parel', '{"parel"}'), ('Mumbai', 'Prabhadevi', '{}'), ('Mumbai', 'Dadar', '{}'),
  ('Mumbai', 'Mahim', '{}'), ('Mumbai', 'Matunga', '{}'), ('Mumbai', 'Sion', '{}'),
  ('Mumbai', 'Wadala', '{}'), ('Mumbai', 'Chembur', '{}'), ('Mumbai', 'Kurla', '{"bkc","bandra kurla complex"}'),
  ('Mumbai', 'Ghatkopar', '{}'), ('Mumbai', 'Vikhroli', '{}'), ('Mumbai', 'Kanjurmarg', '{"kanjur marg"}'),
  ('Mumbai', 'Bhandup', '{}'), ('Mumbai', 'Mulund', '{}'), ('Mumbai', 'Powai', '{"hiranandani powai"}'),
  ('Mumbai', 'Bandra', '{}'), ('Mumbai', 'Khar', '{}'), ('Mumbai', 'Santacruz', '{"santa cruz"}'),
  ('Mumbai', 'Vile Parle', '{"parle"}'), ('Mumbai', 'Juhu', '{}'), ('Mumbai', 'Andheri', '{}'),
  ('Mumbai', 'Versova', '{}'), ('Mumbai', 'Lokhandwala', '{}'), ('Mumbai', 'Oshiwara', '{}'),
  ('Mumbai', 'Jogeshwari', '{}'), ('Mumbai', 'Goregaon', '{}'), ('Mumbai', 'Malad', '{}'),
  ('Mumbai', 'Kandivali', '{"kandivli"}'), ('Mumbai', 'Borivali', '{"borivli"}'), ('Mumbai', 'Dahisar', '{}'),
  ('Navi Mumbai', 'Vashi', '{}'), ('Navi Mumbai', 'Sanpada', '{}'), ('Navi Mumbai', 'Juinagar', '{}'),
  ('Navi Mumbai', 'Nerul', '{}'), ('Navi Mumbai', 'Seawoods', '{"sea woods"}'),
  ('Navi Mumbai', 'CBD Belapur', '{"belapur"}'), ('Navi Mumbai', 'Kharghar', '{}'),
  ('Navi Mumbai', 'Turbhe', '{}'), ('Navi Mumbai', 'Koparkhairane', '{"kopar khairane"}'),
  ('Navi Mumbai', 'Ghansoli', '{}'), ('Navi Mumbai', 'Airoli', '{}'), ('Navi Mumbai', 'Ulwe', '{}'),
  ('Navi Mumbai', 'Kamothe', '{}'), ('Navi Mumbai', 'Navi Mumbai', '{}'),
  ('Thane West', 'Thane West', '{"thane w"}'), ('Thane West', 'Ghodbunder Road', '{"ghodbunder","gb road"}'),
  ('Thane West', 'Majiwada', '{}'), ('Thane West', 'Manpada', '{}'), ('Thane West', 'Vartak Nagar', '{}'),
  ('Thane West', 'Hiranandani Estate', '{}'), ('Thane West', 'Kasarvadavali', '{}'),
  ('Thane West', 'Naupada', '{}'), ('Thane West', 'Kolshet', '{}'), ('Thane West', 'Pokhran Road', '{"pokhran"}'),
  ('Thane West', 'Wagle Estate', '{}'), ('Thane West', 'Balkum', '{}'),
  ('Vasai', 'Vasai', '{"vasai west","vasai east","vasai road"}');

-- Pincode ranges per region (approximate; the owner can correct them).
-- A pincode outside these ranges is "unknown", never "out of area".
INSERT INTO service_pincode_ranges (region, pin_range) VALUES
  ('Mumbai',      int4range(400001, 400104, '[]')),
  ('Navi Mumbai', int4range(400614, 400614, '[]')),
  ('Navi Mumbai', int4range(400701, 400710, '[]')),
  ('Navi Mumbai', int4range(410206, 410210, '[]')),
  ('Thane West',  int4range(400601, 400602, '[]')),
  ('Thane West',  int4range(400604, 400604, '[]')),
  ('Thane West',  int4range(400606, 400608, '[]')),
  ('Thane West',  int4range(400610, 400610, '[]')),
  ('Thane West',  int4range(400615, 400615, '[]')),
  ('Vasai',       int4range(401201, 401202, '[]')),
  ('Vasai',       int4range(401207, 401208, '[]'));
