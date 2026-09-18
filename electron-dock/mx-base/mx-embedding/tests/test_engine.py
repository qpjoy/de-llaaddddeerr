"""Exercise real tensor pooling/normalization with a tiny synthetic model on CPU."""
import types
import unittest

import torch
from fastapi import HTTPException
from test_api import server


class Batch(dict):
    def to(self, device):
        assert device == 'cuda:0'  # Test tensors stay on CPU; production must request CUDA.
        return self


class Tokenizer:
    def __init__(self):
        self.received = None

    def __call__(self, texts, padding, truncation):
        assert padding is False and truncation is False
        self.received = texts
        return {'input_ids': [[ord(c) % 97 + 1 for c in text] for text in texts]}

    def pad(self, rows, padding, return_tensors):
        width = max(map(len, rows['input_ids']))
        ids = [[0] * (width - len(row)) + row for row in rows['input_ids']]
        return Batch(input_ids=torch.tensor(ids))


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.engine = server.QwenEngine.__new__(server.QwenEngine)
        self.engine.torch = torch
        self.engine.settings = server.Settings(dimensions=32, micro_batch=2)
        self.engine.tokenizer = Tokenizer()
        def model(input_ids):
            # Different last tokens identify the record even after left padding.
            hidden = torch.zeros((*input_ids.shape, 1024))
            hidden[:, :, 0] = input_ids.float()
            hidden[:, :, 1] = 1
            hidden[:, :, 32:] = 1000  # Cropping must precede normalization.
            return types.SimpleNamespace(last_hidden_state=hidden)
        self.engine.model = model

    def test_left_padding_order_mrl_crop_and_normalization(self):
        texts = ['ab', 'long c', 'd']
        vectors, tokens = self.engine.encode(texts, 'document')
        self.assertEqual(tokens, sum(map(len, texts)))
        self.assertEqual(len(vectors), 3)
        for text, v in zip(texts, vectors):
            self.assertEqual(len(v), 32)
            self.assertAlmostEqual(sum(x*x for x in v), 1, places=5)
            self.assertAlmostEqual(v[0] / v[1], ord(text[-1]) % 97 + 1, places=4)

    def test_query_instruction_is_explicit_and_limits_do_not_truncate(self):
        self.engine.encode(['refund'], 'query')
        self.assertEqual(self.engine.tokenizer.received, [f'Instruct: {server.QUERY_INSTRUCTION}\nQuery:refund'])
        self.engine.settings.max_length = 2
        with self.assertRaises(HTTPException) as error:
            self.engine.encode(['long'], 'document')
        self.assertEqual(error.exception.status_code, 413)
        self.engine.settings.max_length = 10
        self.engine.settings.token_budget = 3
        with self.assertRaises(HTTPException):
            self.engine.encode(['ab', 'cd'], 'document')


if __name__ == '__main__': unittest.main()
