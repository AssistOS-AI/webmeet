import os
import tempfile
import unittest
from unittest import mock

import dtln_denoise


class DtlnDenoiseTests(unittest.TestCase):
    def setUp(self):
        self.previous_mode = dtln_denoise.DENOISE_MODE

    def tearDown(self):
        dtln_denoise.DENOISE_MODE = self.previous_mode

    def test_denoise_off_returns_original_path(self):
        dtln_denoise.DENOISE_MODE = "off"
        self.assertFalse(dtln_denoise.is_enabled())
        self.assertEqual(dtln_denoise.denoise_file("/tmp/input.wav"), "/tmp/input.wav")

    def test_denoise_enabled_returns_processed_temp_file(self):
        dtln_denoise.DENOISE_MODE = "dtln"
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as handle:
            input_path = handle.name
        output_paths = []
        try:
            with mock.patch.object(dtln_denoise, "_read_wav", return_value=(16000, object())), \
                    mock.patch.object(dtln_denoise, "_process_samples", return_value=object()), \
                    mock.patch.object(dtln_denoise, "_write_wav") as write_wav:
                result = dtln_denoise.denoise_file(input_path)
                output_paths.append(result)

            self.assertNotEqual(result, input_path)
            self.assertTrue(result.endswith(".wav"))
            write_wav.assert_called_once()
        finally:
            for path in [input_path, *output_paths]:
                if path and os.path.exists(path):
                    os.unlink(path)

    def test_denoise_falls_back_to_original_when_processing_fails(self):
        dtln_denoise.DENOISE_MODE = "dtln"
        with mock.patch.object(dtln_denoise, "_read_wav", side_effect=RuntimeError("boom")):
            self.assertEqual(dtln_denoise.denoise_file("/tmp/input.wav"), "/tmp/input.wav")

    def test_denoise_removes_temp_file_when_write_fails(self):
        dtln_denoise.DENOISE_MODE = "dtln"
        created_paths = []

        def fail_write(path, sample_rate, samples):
            created_paths.append(path)
            raise RuntimeError("write failed")

        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as handle:
            input_path = handle.name
        try:
            with mock.patch.object(dtln_denoise, "_read_wav", return_value=(16000, object())), \
                    mock.patch.object(dtln_denoise, "_process_samples", return_value=object()), \
                    mock.patch.object(dtln_denoise, "_write_wav", side_effect=fail_write):
                self.assertEqual(dtln_denoise.denoise_file(input_path), input_path)

            self.assertEqual(len(created_paths), 1)
            self.assertFalse(os.path.exists(created_paths[0]))
        finally:
            if os.path.exists(input_path):
                os.unlink(input_path)

    def test_missing_dtln_block_adapter_fails_clearly(self):
        with self.assertRaisesRegex(RuntimeError, "expected block inference adapter"):
            dtln_denoise._infer_block(object(), object())

    def test_unsupported_sample_rate_uses_original_path(self):
        dtln_denoise.DENOISE_MODE = "dtln"
        with mock.patch.object(dtln_denoise, "_read_wav", return_value=(48000, object())):
            self.assertEqual(dtln_denoise.denoise_file("/tmp/input.wav"), "/tmp/input.wav")


if __name__ == "__main__":
    unittest.main()
