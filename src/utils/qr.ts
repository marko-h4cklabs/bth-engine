import QRCode from 'qrcode';

export async function generateQrBase64(url: string): Promise<string> {
  const dataUrl = await QRCode.toDataURL(url, {
    width: 400,
    margin: 1,
    color: {
      dark: '#0A0A0A',
      light: '#FFFFFF',
    },
  });
  // Return only the base64 part (strip "data:image/png;base64,")
  return dataUrl.split(',')[1] ?? '';
}
