-- Bartez AI — Seed inicial del catálogo de asistentes
-- Los activos arrancan encendidos, los dormidos quedan con activo=false y prompt vacío por ahora.

insert into asistentes (nombre, area, modelo, autonomia, activo, prompt) values
    -- ACTIVOS
    ('Correo',       'correo',       'sonnet', 0,  true,  ''),
    ('Notion',       'notion',       'haiku',  50, true,  ''),
    ('Seguimientos', 'seguimientos', 'haiku',  50, true,  ''),
    ('WhatsApp',     'whatsapp',     'sonnet', 0,  true,  ''),
    ('Prospección',  'prospeccion',  'sonnet', 20, true,  ''),
    ('Analítica',    'analitica',    'haiku',  100,true,  ''),
    -- DORMIDOS (framework listo, no activados)
    ('Facturación',        'facturacion',   'haiku', 0, false, ''),
    ('Cobranzas',          'cobranzas',     'haiku', 0, false, ''),
    ('Compras',            'compras',       'haiku', 0, false, ''),
    ('Inventario',         'inventario',    'haiku', 0, false, ''),
    ('Contenido',          'contenido',     'sonnet',0, false, ''),
    ('RR.HH.',             'rrhh',          'haiku', 0, false, ''),
    ('Legal',              'legal',         'sonnet',0, false, ''),
    ('Calendario',         'calendario',    'haiku', 0, false, ''),
    ('Base de conocimiento','kb',           'haiku', 0, false, ''),
    ('IT interno',         'it',            'haiku', 0, false, ''),
    ('Redes sociales',     'redes',         'sonnet',0, false, '')
on conflict (nombre) do nothing;
