//! Bi-planar NV12 packing shared by the native frame producers.
//!
//! ScreenCaptureKit (macOS, `420v`) and PipeWire (Linux, `NV12`) can both hand
//! frames over as one luma plane plus one interleaved chroma plane at half
//! resolution. FFmpeg's `rawvideo` demuxer expects the two planes back to back
//! with no stride padding (`nv12` = `width × height` luma followed by
//! `width × height / 2` interleaved CbCr), so every plane's rows are copied
//! individually when the producer's pitch is wider than the payload.
//!
//! Kept free of platform types so the layout rules are unit-tested on every
//! host, not only on the platform that runs them.

/// A single plane view into a producer's frame buffer.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Nv12Plane<'a> {
    /// Backing bytes as the producer exposed them.
    pub data: &'a [u8],
    /// Byte offset of the plane's first row inside `data`.
    pub offset: usize,
    /// Row pitch in bytes — may exceed the row's payload.
    pub stride: usize,
}

impl<'a> Nv12Plane<'a> {
    /// Number of bytes a tightly-packed row of `row_bytes` needs.
    fn rows(&self, row_bytes: usize, rows: usize) -> Option<usize> {
        if row_bytes == 0 || rows == 0 || self.stride < row_bytes {
            return None;
        }
        // The last row only needs its payload, not the trailing padding.
        let last = self
            .offset
            .checked_add(self.stride.checked_mul(rows - 1)?)?;
        let end = last.checked_add(row_bytes)?;
        (end <= self.data.len()).then_some(end)
    }
}

/// Pack luma + chroma planes into the contiguous NV12 layout `rawvideo` reads.
///
/// `width` and `height` must be even — NV12 subsamples both axes by two — and
/// the luma plane is `height` rows while the chroma plane is `height / 2`
/// rows of interleaved Cb/Cr.
pub(crate) fn pack_nv12(
    luma: Nv12Plane<'_>,
    chroma: Nv12Plane<'_>,
    width: u32,
    height: u32,
) -> Option<Vec<u8>> {
    if width == 0 || height == 0 || !width.is_multiple_of(2) || !height.is_multiple_of(2) {
        return None;
    }
    let row_bytes = width as usize;
    let luma_rows = height as usize;
    let chroma_rows = height as usize / 2;

    luma.rows(row_bytes, luma_rows)?;
    chroma.rows(row_bytes, chroma_rows)?;

    let mut packed = Vec::with_capacity(row_bytes * (luma_rows + chroma_rows));
    copy_rows(&luma, row_bytes, luma_rows, &mut packed);
    copy_rows(&chroma, row_bytes, chroma_rows, &mut packed);
    Some(packed)
}

fn copy_rows(plane: &Nv12Plane<'_>, row_bytes: usize, rows: usize, packed: &mut Vec<u8>) {
    for row in 0..rows {
        let start = plane.offset + row * plane.stride;
        packed.extend_from_slice(&plane.data[start..start + row_bytes]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 4×2 luma + 4×1 chroma: the smallest frame with a real chroma plane.
    #[test]
    fn packs_tightly_without_padding() {
        let luma = Nv12Plane {
            data: &[1, 2, 3, 4, 5, 6, 7, 8],
            offset: 0,
            stride: 4,
        };
        let chroma = Nv12Plane {
            data: &[0x10, 0x20, 0x30, 0x40],
            offset: 0,
            stride: 4,
        };
        let packed = pack_nv12(luma, chroma, 4, 2).expect("packs");
        assert_eq!(packed, vec![1, 2, 3, 4, 5, 6, 7, 8, 0x10, 0x20, 0x30, 0x40]);
        assert_eq!(packed.len(), 4 * 2 * 3 / 2);
    }

    #[test]
    fn strips_stride_padding_and_honours_offsets() {
        // 4-byte rows padded to a 6-byte pitch, with a 2-byte header.
        let luma_data = [0xFF, 0xFF, 1, 2, 3, 4, 0xAA, 0xAA, 5, 6, 7, 8, 0xAA, 0xAA];
        let luma = Nv12Plane {
            data: &luma_data,
            offset: 2,
            stride: 6,
        };
        let chroma_data = [0xAA, 0xAA, 0x10, 0x20, 0x30, 0x40, 0xAA, 0xAA];
        let chroma = Nv12Plane {
            data: &chroma_data,
            offset: 2,
            stride: 6,
        };
        let packed = pack_nv12(luma, chroma, 4, 2).expect("packs");
        assert_eq!(packed, vec![1, 2, 3, 4, 5, 6, 7, 8, 0x10, 0x20, 0x30, 0x40]);
    }

    #[test]
    fn rejects_short_planes_and_odd_geometry() {
        let luma = Nv12Plane {
            data: &[0u8; 8],
            offset: 0,
            stride: 4,
        };
        let chroma = Nv12Plane {
            data: &[0u8; 4],
            offset: 0,
            stride: 4,
        };
        assert!(pack_nv12(luma, chroma, 4, 2).is_some());

        // Odd dimensions cannot be NV12.
        assert!(pack_nv12(luma, chroma, 3, 2).is_none());
        assert!(pack_nv12(luma, chroma, 4, 3).is_none());

        // A chroma plane one row short is rejected rather than truncated.
        let short_chroma = Nv12Plane {
            data: &[0u8; 2],
            offset: 0,
            stride: 4,
        };
        assert!(pack_nv12(luma, short_chroma, 4, 2).is_none());

        // A pitch narrower than the row is a producer bug.
        let narrow = Nv12Plane {
            data: &[0u8; 8],
            offset: 0,
            stride: 2,
        };
        assert!(pack_nv12(narrow, chroma, 4, 2).is_none());
    }

    #[test]
    fn lays_out_a_realistic_frame() {
        let width = 6;
        let height = 4;
        let luma_data: Vec<u8> = (0..(width * height) as u8).collect();
        let chroma_data: Vec<u8> = (100..(100 + width * height / 2) as u8).collect();
        let packed = pack_nv12(
            Nv12Plane {
                data: &luma_data,
                offset: 0,
                stride: width as usize,
            },
            Nv12Plane {
                data: &chroma_data,
                offset: 0,
                stride: width as usize,
            },
            width,
            height,
        )
        .expect("packs");
        assert_eq!(packed.len(), (width * height * 3 / 2) as usize);
        assert_eq!(&packed[..(width * height) as usize], &luma_data[..]);
        assert_eq!(&packed[(width * height) as usize..], &chroma_data[..]);
    }
}
