# VIP Go

MVP de campanha corporativa de atividade física, com registro manual, percursos por GPS e foco em privacidade.

## Executar localmente

Requisitos: Node.js 22+ e npm.

```bash
npm install
npm run dev
```

Abra `http://localhost:5173`. Crie uma conta e entre em uma campanha usando um código. O código inicial de demonstração é `VIPGO2026`; também é possível criar uma campanha própria no perfil e compartilhar o código gerado com colaboradores.

## Recursos desta versão

- Contas de colaboradores e entrada em campanha por código.
- Início com participantes da campanha, opção de seguir/deixar de seguir e feed de atividades dos perfis seguidos que compartilham atividades. Os registros permitem anexar até 4 fotos ou vídeos (máximo de 12 MB cada) para exibição no feed.
- Perfil com foto JPG, PNG ou WebP de até 5 MB, controlada por uma opção de visibilidade para os participantes da campanha.
- Criação e administração da campanha pela conta que a criou; configuração de meta, período semanal ou mensal e reconhecimento/premiação.
- Criação de desafios individuais pela aba **Desafios** da administração, com datas, período, meta em minutos, descrição e premiação; os participantes acompanham o próprio progresso na página **Desafios**.
- Registro de caminhada, corridas de rua e trilha, ciclismo, mountain bike, patinação, canoagem, escalada, surfe, skate, natação, musculação, treino funcional, crossfit, yoga, pilates, dança, futebol, futsal, basquete, vôlei, tênis, beach tennis, remo e outras modalidades, com data, duração e distância opcional.
- O registro manual adapta os campos à modalidade, calcula a duração pelos horários de início e término e oculta distância em atividades como musculação e yoga.
- Aba **Mapas** para gravar caminhada, corrida ou pedal por GPS enquanto o app está aberto, acompanhar tempo e distância, e rever o percurso salvo.
- Na gravação por GPS, permite conectar sensores compatíveis com o serviço Bluetooth Heart Rate e salvar frequência média e máxima apenas no histórico privado do participante.
- Rotas de outros participantes da mesma campanha aparecem somente quando a pessoa compartilha a atividade e opta por compartilhar aquele percurso. Os primeiros e últimos 200 m são ocultados; percursos de até 400 m não podem ser compartilhados. Não há localização ao vivo de terceiros.
- Rankings individual e de equipes, com a regra publicada: 1 minuto registrado = 1 ponto no período selecionado.
- Equipes geridas pela administração; colaboradores podem escolher uma equipe.
- Medalhas por primeiro registro, 10 e 25 atividades e conclusão da meta semanal.
- Preferências para aparecer no ranking e compartilhar atividades no mural.
- O GPS só é solicitado após tocar em **Iniciar percurso** ou **Minha localização**. Registros manuais não coletam localização. O ranking e o mural não recebem coordenadas; o mural mostra só modalidade, duração e distância.

A administração da campanha fica na navegação principal e só aparece para a conta responsável. Suas alterações de campanha, equipes e desafios são aplicadas à página dos participantes. O período da campanha pode ser semanal (segunda a domingo) ou mensal. O banco local SQLite fica em `server/data/`.

## Produção

```bash
npm run build
NODE_ENV=production SESSION_SECRET='use-uma-chave-aleatoria-longa-com-pelo-menos-32-caracteres' COOKIE_SECURE=true npm run preview
```

Em produção, use HTTPS, uma chave privada e persistência de disco para o SQLite. Para várias instâncias, migre o banco para um serviço gerenciado.

O navegador exige HTTPS (ou localhost) e permissão explícita para usar a localização. Mantenha o app aberto durante a gravação: navegadores móveis podem suspender o GPS em segundo plano. O mapa usa Leaflet e blocos do OpenStreetMap com atribuição visível. Para tráfego alto, configure um provedor de mapas adequado à demanda.

A leitura de batimentos usa o serviço Bluetooth Heart Rate padrão e depende de navegador compatível e de o sensor anunciar esse serviço. Relógios como Apple Watch e algumas linhas Garmin/Fitbit podem exigir um app nativo ou integração própria do fabricante para sincronizar dados.
