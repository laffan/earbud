"""Export Dettato's pitched-note network for Earbud's offline mobile runtime."""
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import onnxruntime as ort
import torch
from torch import nn
from dettato.transcriber import Transcriber
from dettato.transcriber.model import PitchMix
from dettato.transcriber.frontend import HCQT

# Two-second windows keep activation and attention memory bounded on phones.
SAMPLES = 32000
DEST = Path(__file__).resolve().parents[1] / "public/models/dettato"


class Spectrum(HCQT):
    def _pow(self, audio, n_fft, win):
        spectrum = torch.stft(audio, n_fft, hop_length=160, window=win,
                              return_complex=False, pad_mode="constant")
        return spectrum.square().sum(-1)


class ShiftMix(nn.Module):
    """Equivalent depthwise convolution; avoids exporting dense 88x88 lane matrices."""
    def __init__(self, layer):
        super().__init__()
        self.radius = max(map(abs, layer.offsets))
        weights = layer.taps.new_zeros(layer.taps.shape[0], 1, 1, 2 * self.radius + 1)
        for index, offset in enumerate(layer.offsets):
            weights[:, 0, 0, self.radius + offset] = layer.taps[:, index].detach()
        self.register_buffer("weights", weights)

    def forward(self, x):
        return nn.functional.conv2d(x, self.weights, padding=(0, self.radius), groups=self.weights.shape[0])


class Network(nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, audio):
        logits = self.net(audio)
        return torch.stack([logits[name].sigmoid() for name in self.net.head_names])


def main():
    torch.set_num_threads(2)
    model = Network(Transcriber.from_pretrained("cpu").model).eval()
    example = torch.randn(1, SAMPLES, generator=torch.Generator().manual_seed(23)) * 0.05
    with torch.no_grad():
        expected = model(example).numpy()
    model.net.front.__class__ = Spectrum
    for block in [*model.net.layers, *model.net.refine]:
        if isinstance(getattr(block, "pmix", None), PitchMix):
            block.pmix = ShiftMix(block.pmix)
    DEST.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=DEST) as folder:
        output = Path(folder) / "transcriber.onnx"
        torch.onnx.export(model, example, str(output), input_names=["audio"], output_names=["maps"],
                          opset_version=17, dynamo=False)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        sess = ort.InferenceSession(str(output), options, providers=["CPUExecutionProvider"])
        actual, = sess.run(None, {"audio": example.numpy()})
        np.testing.assert_allclose(actual, expected, atol=0.001, rtol=0.002)
        output.replace(DEST / output.name)
    print("Exported and verified", DEST / output.name)


if __name__ == "__main__":
    main()
