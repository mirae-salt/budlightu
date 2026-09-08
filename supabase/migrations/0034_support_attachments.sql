-- A support message can carry a file.
--
-- WHY
-- ---
-- Theo Cliche, 2026-09-04, in the middle of a thread about an upload that would not work:
-- "It also does not allow me to send you pictures on this log". He was right. The support
-- thread was text only, so the one thing that would have told us what was wrong with his
-- receipt was the one thing he could not send. Robin has the same problem from the other
-- side: she cannot ask to see the file, only describe what she wants.
--
-- WHY THE FILE DOES NOT GO THROUGH OUR API
-- ----------------------------------------
-- Mirae, 2026-09-08: "근데 여기도 파일제한 있으면 먼소영". Exactly the point. Vercel refuses
-- a serverless function request body over 4.5 MB before our code runs, which is what broke
-- Theo's upload in the first place. An attachment posted the same way would hit the same
-- wall, and the file he most needs to send is precisely the one that is too big.
--
-- So the browser uploads straight to Supabase Storage with a short-lived signed URL and
-- only the resulting key comes back through us. The `support` bucket is private and
-- carries its own 20 MB limit and mime allowlist, enforced by Storage rather than by us,
-- because with this design our code never sees the bytes and cannot check them.
--
-- ONE FILE PER MESSAGE
-- --------------------
-- Columns on the message rather than a child table. A second file is a second message,
-- which is also how the thread reads: each upload keeps its own author and timestamp for
-- free, and there is no join to get wrong. If a real need for grouped attachments appears,
-- a child table can be added without moving these.

alter table portal_question_messages
  -- Object key in the private `support` bucket. Null means a plain text message, which is
  -- almost all of them.
  add column if not exists attachment_key text,
  -- Content type as Storage recorded it. Decides whether the thread renders an image
  -- inline or offers a link, and is what the serving route returns.
  add column if not exists attachment_mime text,
  -- Size in bytes, so a zero-byte upload is visible without fetching the object. An empty
  -- file cost Jackson Bennett his whole September receipt on 2026-09-05.
  add column if not exists attachment_bytes bigint,
  -- What the student called it. Shown in the thread and used for the download filename.
  -- Never used to build the storage key: the key is generated, so a hostile filename
  -- cannot steer where the object lands.
  add column if not exists attachment_name text;

-- A key with no type is a row nothing can render, and a type with no key points at
-- nothing. Either both or neither.
alter table portal_question_messages
  drop constraint if exists portal_question_messages_attachment_complete;
alter table portal_question_messages
  add constraint portal_question_messages_attachment_complete
  check (
    (attachment_key is null and attachment_mime is null)
    or (attachment_key is not null and attachment_mime is not null)
  );

-- The serving route looks a message up by its key to decide who may read it, and the
-- thread views filter to the messages that have one.
create index if not exists portal_question_messages_attachment_key_idx
  on portal_question_messages (attachment_key)
  where attachment_key is not null;
