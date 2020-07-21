import FormData from 'form-data';

import errors from './errors';

const validFeedSlugRe = /^[\w]+$/;
const validUserIdRe = /^[\w-]+$/;

function validateFeedSlug(feedSlug: string): string {
  /*
   * Validate that the feedSlug matches \w
   */
  if (!validFeedSlugRe.test(feedSlug)) {
    throw new errors.FeedError(`Invalid feedSlug, please use letters, numbers or _: ${feedSlug}`);
  }

  return feedSlug;
}

function validateUserId(userId: string): string {
  /*
   * Validate the userId matches \w
   */
  if (!validUserIdRe.test(userId)) {
    throw new errors.FeedError(`Invalid userId, please use letters, numbers, - or _: ${userId}`);
  }

  return userId;
}

function rfc3986(str: string): string {
  return str.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function isReadableStream(obj: NodeJS.ReadStream): obj is NodeJS.ReadStream {
  return obj !== null && typeof obj === 'object' && typeof (obj as NodeJS.ReadStream)._read === 'function';
}

function validateFeedId(feedId: string): string {
  /*
   * Validate that the feedId matches the spec user:1
   */
  const parts = feedId.split(':');
  if (parts.length !== 2) {
    throw new errors.FeedError(`Invalid feedId, expected something like user:1 got ${feedId}`);
  }

  const [feedSlug, userId] = parts;
  validateFeedSlug(feedSlug);
  validateUserId(userId);
  return feedId;
}

function addFileToFormData(uri: string | File | NodeJS.ReadStream, name?: string, contentType?: string): FormData {
  const data = new FormData();

  let fileField: File | NodeJS.ReadStream | { uri: string; name: string; type?: string };

  if (isReadableStream(uri as NodeJS.ReadStream)) {
    fileField = uri as NodeJS.ReadStream;
  } else if (uri && uri.toString && uri.toString() === '[object File]') {
    fileField = uri as File;
  } else {
    fileField = { uri: uri as string, name: name || (uri as string).split('/').reverse()[0] };
    if (contentType != null) fileField.type = contentType;
  }

  data.append('file', fileField);
  return data;
}

function replaceStreamObjects<T, V>(obj: T): V {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  if (Array.isArray(obj)) return obj.map((v) => replaceStreamObjects(v));

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  if (Object.prototype.toString.call(obj) !== '[object Object]') return obj;

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  if (typeof obj.ref === 'function') return obj.ref();

  const cloned = {};
  Object.keys(obj).forEach((k) => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    cloned[k] = replaceStreamObjects(obj[k]);
  });

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  return cloned;
}

export default {
  validateFeedId,
  validateFeedSlug,
  validateUserId,
  rfc3986,
  isReadableStream,
  addFileToFormData,
  replaceStreamObjects,
};