import StreamClient, { FileUploadAPIResponse, OnUploadProgress } from './client';

export type ImageProcessOptions = {
  w?: number | string;
  h?: number | string;
  resize?: string | 'clip' | 'crop' | 'scale' | 'fill';
  crop?: string | 'top' | 'bottom' | 'left' | 'right' | 'center';
};

export default class StreamImageStore {
  client: StreamClient;

  token: string;

  constructor(client: StreamClient, token: string) {
    this.client = client;
    this.token = token;
  }

  // React Native does not auto-detect MIME type, you need to pass that via contentType
  // param. If you don't then Android will refuse to perform the upload
  upload(
    uri: string | File | NodeJS.ReadStream,
    name?: string,
    contentType?: string,
    onUploadProgress?: OnUploadProgress,
  ) {
    /**
     * upload an Image File instance or a readable stream of data
     * @param {File|Buffer|string} uri - File object or Buffer or URI
     * @param {string} [name] - file name
     * @param {string} [contentType] - mime-type
     * @param {function} [onUploadProgress] - browser only, Function that is called with upload progress
     * @return {Promise}
     */
    return this.client.upload('images/', uri, name, contentType, onUploadProgress);
  }

  delete(uri: string) {
    return this.client.delete({
      url: `images/`,
      qs: { url: uri },
      signature: this.token,
    });
  }

  process(uri: string, options: ImageProcessOptions) {
    const params = Object.assign(options, { url: uri });
    if (Array.isArray(params.crop)) {
      params.crop = params.crop.join(',');
    }

    return this.client.get<FileUploadAPIResponse>({
      url: `images/`,
      qs: params,
      signature: this.token,
    });
  }

  thumbnail(
    uri: string,
    w: number | string,
    h: number | string,
    { crop, resize } = { crop: 'center', resize: 'clip' },
  ) {
    return this.process(uri, { w, h, crop, resize });
  }
}