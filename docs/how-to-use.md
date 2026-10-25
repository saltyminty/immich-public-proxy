# Sharing from Immich

## Filter a shared gallery by tags (custom build)

When the share allows metadata, **Filter by tags** appears above the gallery.
Wait for the tags to finish loading, then select one or more checkboxes. A photo
must have **every selected tag** to appear. **Clear filters** restores all items.
The photo viewer navigates through the matching items, and **Download matching**
downloads those same items. With no tags selected, the usual whole-album download
remains available. Saved tags remain usable while **Updating tags…** is shown;
updates preserve your selections and wait until the photo viewer closes. A
selected tag that disappears remains marked **no longer available** and matches
no photos until you remove that selection.

To share a filtered view, select the tags and copy the address from your browser.
The URL updates automatically, for example
`https://photos.example.com/share/<key>?tags=Alice&tags=Bob`.
Opening that link selects both tags and shows only photos with **all** of them.
Reloading keeps the selection; **Clear filters** removes the tag parameters.
Tag names match exactly, including their full hierarchical names. The browser
encodes spaces and punctuation for you. Repeated `tags` parameters keep a comma
inside a tag name distinct from a list of tags; a manually entered
`?tags=Alice,Bob` also selects both names.

A filtered link waits for its selected tags before showing photos. If a tag
cannot be found, has an ambiguous name, or tags cannot be loaded, it does not
silently show the whole album. Retry loading or clear the filters to continue.
Filters select a view of the existing shared album; visitors can clear them.

Opening or reloading an album checks its membership and loads tags for new
photos. Once saved tags are five minutes old, a visit starts a background check
for tag edits. This does not watch Immich continuously. If a refresh fails, saved
tags remain usable and Retry becomes available. First visits and proxy restarts
still need an initial load. An unfiltered gallery remains available if tags
cannot load.

The dropdown uses explicit Immich tags, including their full hierarchical names.
Face-recognition People labels are separate and are not included.

The **About** link below the gallery opens the version and licence information,
with a link to the exact source commit for this custom build on GitHub.

Other than the initial configuration during [installation](/installation), everything is managed through Immich.
IPP has no admin interface of its own.

Share your photos, videos and albums as normal through Immich. Because you set the **External domain** in Immich's
settings to the URL of IPP, the links Immich generates already point at the proxy:

<img src="./public/share-link.webp" width="751" height="524" alt="Sharing a link from Immich">

## Share links

A standard link looks like `https://photos.example.com/share/<key>`, where the key is the shared link's public ID
in Immich. If you give the shared link a custom URL in Immich, IPP serves it at `https://photos.example.com/s/<slug>`
instead. Slug links can be turned off with [`allowSlugLinks`](/config/ipp-options#allowsluglinks).

The settings on the shared link in Immich are respected:

- **Password.** Visitors must enter the password before IPP serves anything from the share. It is remembered in an
  encrypted cookie for an hour, after which they are asked again.
- **Expiry.** An expired link returns a 404, the same as an unknown one. The expiry date can be shown on the gallery
  with [`gallery.showExpiryDate`](/config/gallery#showexpirydate).
- **Allow downloads.** Decides whether Immich will serve the original files. See
  [`allowDownload`](/config/ipp-options#allowdownload) for how IPP's own download buttons interact with it.
- **Show metadata.** When it is off, IPP hides the description, EXIF and location data regardless of its own
  [metadata settings](/config/metadata).
- **Allow public user to upload.** When it is on and you run the optional upload service, the gallery shows an
  **Add photos** button. See [Let visitors send photos back](/visitor-uploads).

## What visitors see

- A share containing a single image opens the image file directly, so you can embed the link anywhere you would a
  normal image. Set [`gallery.singleImage`](/config/gallery#singleimage) to show a gallery page instead. A single video
  opens a gallery page by default ([`gallery.singleVideo`](/config/gallery#singlevideo)).
- Everything else opens as a gallery styled to match Immich, in light or dark mode following the visitor's system
  preference, with a lightbox for viewing each photo or video.
- Very large shares stay smooth, however many photos they contain.
- When downloads are allowed, visitors can download a single item, select several to download together as a zip, or
  download the whole share.
- Photos can be grouped under month or day headers with [`gallery.groupByDate`](/config/gallery#groupbydate).
- An info sidebar in the lightbox shows whatever [metadata](/config/metadata) you have chosen to reveal. Nothing is
  revealed by default.
- When the share accepts uploads, visitors can send their own photos and videos into it with the **Add photos**
  button.

Try it on the [live demo](https://demo.ipp.nz/s/demo-gallery).

Next: [Upgrading](/upgrading), or head to [Configuration](/config/) to tune the gallery.
