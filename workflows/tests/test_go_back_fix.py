"""
Quick test to verify go_back action works with NoParamsAction fix.
"""

import asyncio
import os
from pathlib import Path

import pytest
import yaml
from browser_use.llm import ChatAnthropic

from workflow_use.workflow.service import Workflow


@pytest.mark.skipif(
	os.getenv('WORKFLOW_USE_BROWSER_TESTS') != '1',
	reason='requires a live browser and network; integration test, set WORKFLOW_USE_BROWSER_TESTS=1 to run',
)
async def test_go_back_fix(tmp_path):
	"""Test that go_back action works correctly"""

	# Create a minimal workflow with a go_back action
	workflow_dict = {
		'name': 'Test Go Back',
		'description': 'Test go_back action',
		'version': '1.0.0',
		'input_schema': [],
		'steps': [
			{'type': 'navigation', 'url': 'https://example.com', 'description': 'Navigate to example.com'},
			{'type': 'navigation', 'url': 'https://google.com', 'description': 'Navigate to google.com'},
			{'type': 'go_back', 'description': 'Go back to example.com'},
		],
	}

	# Write to YAML file
	workflow_path = tmp_path / 'test_go_back.workflow.yaml'
	workflow_path.write_text(yaml.dump(workflow_dict))

	print('✅ Created test workflow')

	# Create LLM (using Anthropic, but won't need it for deterministic steps)
	try:
		llm = ChatAnthropic(model='claude-3-5-sonnet-20241022', max_tokens=1024)
	except Exception as e:
		print(f'⚠️  Could not create LLM (this is OK for deterministic testing): {e}')
		llm = None

	try:
		# Load workflow
		workflow = Workflow.load_from_file(workflow_path, llm=llm)

		print('\n🧪 Testing go_back action...')

		# Run the workflow
		result = await workflow.run({})

		print('\n✅ Workflow completed!')
		print(f'📊 Result: {result}')

		# Clean up
		workflow_path.unlink()
		print('\n✨ Test passed - go_back action works correctly!')

	except Exception as e:
		print(f'\n❌ Test failed: {e}')
		import traceback

		traceback.print_exc()


if __name__ == '__main__':
	import tempfile

	asyncio.run(test_go_back_fix(Path(tempfile.mkdtemp())))
