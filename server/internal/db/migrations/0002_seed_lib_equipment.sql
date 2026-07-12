INSERT INTO lib_equipment (name, locale_token) VALUES
    ('Персональный компьютер', 'equipment.pc'),
    ('Роутер базовый',         'equipment.router_t1'),
    ('Роутер офисный',         'equipment.router_t2'),
    ('Роутер расширенный',     'equipment.router_t3'),
    ('Сервер',                 'equipment.server'),
    ('Шлюз в интернет',        'equipment.gateway'),
    ('Кулер с водой',          'equipment.cooler'),
    ('Холодильник',            'equipment.fridge'),
    ('Кофеварка',              'equipment.coffee_machine')
ON CONFLICT (locale_token) DO NOTHING;
