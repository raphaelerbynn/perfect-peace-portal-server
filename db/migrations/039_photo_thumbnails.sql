-- 039 (B17): a small square thumbnail next to each pupil and staff photo.
--
-- Photos are now processed on upload (sharp): the photo is stored as a 512px
-- WebP with its EXIF / GPS metadata removed, plus a 128px thumbnail for lists.
-- photo_thumb_key holds the thumbnail's storage key (NULL = none: photos
-- uploaded before this change, which the API serves full size instead).
-- Existing rows are untouched. Safe to re-run; move-data may already have
-- created the column from the model.
--

ALTER TABLE "dbo"."Student" ADD COLUMN IF NOT EXISTS photo_thumb_key VARCHAR(120);
ALTER TABLE "dbo"."Teacher" ADD COLUMN IF NOT EXISTS photo_thumb_key VARCHAR(120);
